const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { parseWebhook, normalizeGroup, webhookFingerprint, notifyConfiguredGroups } = require('./groupNotifications');
const { notifyAll, getNotificationConfig } = require('./notifications');
const { resolveOrderLocation } = require('./orderLocation');

const DEFAULT_CLIENT_POLICY = { latestBuild: 20400, minWriteBuild: 0, minReadBuild: 0, apiSchema: 2, forceAfter: '', message: '请升级到最新版本' };
const WRITE_ACTIONS = new Set(['createOrder', 'assignWorker', 'batchAssignWorker', 'updateOrder', 'urgent', 'editTime', 'finishOrder', 'cancelOrder', 'failOrder', 'feedback', 'createUser', 'updateUser', 'unbindUser', 'createSource', 'deleteSource', 'createNotificationGroup', 'updateNotificationGroup', 'deleteNotificationGroup']);

const fields = {
  assign: ['workerName', 'workerPhone'],
  editTime: ['appointmentTime', 'appointmentLogs', 'feedbacks', 'isUrgent'],
  finish: ['status', 'settleType', 'cashAmount', 'wechatAmount', 'alipayAmount', 'finalAmount', 'depositAmount', 'totalAmount', 'remainingAmount', 'companionWorkers', 'finishPhotos', 'finishNote', 'paymentLogs', 'isUrgent', 'finishTime'],
  feedback: ['feedbacks']
};

const ARCHIVED_STATUSES = ['已完工', '未成单'];

function paymentNotificationSnapshot(order, after, details) {
  return {
    city: order.city || '', customerPhone: order.customerPhone || '', address: order.address || '',
    appointmentTime: order.appointmentTime || '', workerName: order.workerName || '', source: order.source || '',
    creatorName: order.creatorName || '', feedbacks: after.feedbacks || order.feedbacks || [],
    finishNote: after.finishNote || order.finishNote || '', status: after.status || order.status || '',
    totalAmount: Number(after.totalAmount || 0), finalAmount: Number(after.finalAmount || 0),
    depositAmount: Number(after.depositAmount || 0), remainingAmount: Number(after.remainingAmount || 0),
    cashAmount: Number(after.cashAmount || 0), wechatAmount: Number(after.wechatAmount || 0), alipayAmount: Number(after.alipayAmount || 0),
    eventType: details.eventType, operationType: details.operationType, amountThisTime: details.amountThisTime,
    paidBefore: details.paidBefore, paymentChannelCorrected: details.paymentChannelCorrected,
    correctionReason: details.correctionReason || ''
  };
}

async function commitPaymentTransaction(orderId, orderData, paymentData, eventData) {
  const transaction = await db.startTransaction();
  try {
    await transaction.collection('orders').doc(orderId).update({ data: orderData });
    await transaction.collection('payment_transactions').add({ data: paymentData });
    await transaction.collection('notification_events').add({ data: eventData });
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('支付事务回滚失败'); }
    throw error;
  }
}

async function commitOrderEventTransaction(orderId, orderData, eventData) {
  const transaction = await db.startTransaction();
  try {
    await transaction.collection('orders').doc(orderId).update({ data: orderData });
    await transaction.collection('notification_events').add({ data: eventData });
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('订单事务回滚失败'); }
    throw error;
  }
}

async function createOrderEventTransaction(orderData, eventBase) {
  const transaction = await db.startTransaction();
  try {
    const result = await transaction.collection('orders').add({ data: orderData });
    await transaction.collection('notification_events').add({ data: { ...eventBase, orderId: result._id, eventId: 'evt_' + result._id, eventKey: `order:${result._id}:created` } });
    await transaction.commit();
    return result;
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('新订单事务回滚失败'); }
    throw error;
  }
}

function pick(value, allowed) {
  const out = {};
  const input = value && typeof value === 'object' ? value : {};
  allowed.forEach(key => { if (input[key] !== undefined) out[key] = input[key]; });
  return out;
}

function validateCreateOrder(data) {
  const input = data && typeof data === 'object' ? data : {};
  for (const [key, label] of [['customerPhone', '客户电话'], ['address', '服务地址'], ['appointmentTime', '预约时间']]) {
    if (!String(input[key] || '').trim()) return `请填写${label}`;
  }
  if (!/^1\d{10}$/.test(String(input.customerPhone).trim())) return '客户电话格式不正确';
  if (input.totalAmount !== undefined && (!Number.isFinite(Number(input.totalAmount)) || Number(input.totalAmount) < 0)) return '工程金额不正确';
  return '';
}

function validateSettlement(data) {
  const input = data && typeof data === 'object' ? data : {};
  const keys = ['cashAmount', 'wechatAmount', 'alipayAmount'];
  for (const key of keys) if (!Number.isFinite(Number(input[key] || 0)) || Number(input[key] || 0) < 0) return '收款金额不正确';
  const paid = keys.reduce((sum, key) => sum + Number(input[key] || 0), 0);
  if (paid <= 0) return '请输入至少一项收款金额';
  const total = Number(input.totalAmount || paid);
  const remain = Number(input.remainingAmount || 0);
  if (!Number.isFinite(total) || total < paid || remain < 0 || Math.abs(total - paid - remain) > 0.01) return '结算金额不正确';
  return '';
}

async function currentUser() {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return null;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const testRes = await db.collection('users').where({
    isTest: true,
    testSessionOpenid: openid,
    testSessionTime: _.gt(cutoff)
  }).limit(1).get();
  if (testRes.data && testRes.data[0]) return testRes.data[0];
  const res = await db.collection('users').where({ openid }).limit(1).get();
  return res.data && res.data[0] || null;
}

const hasRole = (user, roles) => Boolean(user && roles.includes(user.role));
const canSettle = (user, order) => Boolean(
  user && order && (hasRole(user, ['leader']) || (user.role === 'worker' && order.workerPhone === user.phone))
);
const canAccess = (user, order) => {
  if (user.role === 'admin') return true;
  if (user.role === 'worker') return Boolean(user.phone && order.workerPhone === user.phone);
  const cities = Array.isArray(user.cities) ? user.cities : [];
  return !order.city || cities.includes(order.city);
};

const normalizedCities = value => {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim());
  if (value && typeof value === 'object') return Object.values(value).filter(item => typeof item === 'string' && item.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
};

function canServeCity(worker, city) {
  const cities = normalizedCities(worker && worker.cities);
  return !city || !cities.length || cities.includes(city);
}

async function findAssignableWorker(phone) {
  const workerPhone = String(phone || '').trim();
  if (!/^1\d{10}$/.test(workerPhone)) return { error: '派单师傅手机号格式错误' };
  const result = await db.collection('users').where({ phone: workerPhone }).limit(1).get();
  const worker = result.data && result.data[0];
  if (!worker || !['worker', 'leader'].includes(worker.role)) return { error: '派单师傅不存在或无接单权限' };
  return { worker };
}

const clientUser = user => ({
  _id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  role: user.role || '',
  cities: normalizedCities(user.cities),
  isTest: Boolean(user.isTest),
  // 前端仅需判断是否已经绑定，不能获得真实 openid 或测试会话。
  openid: Boolean(user.openid)
});

const clientWorker = user => ({
  _id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  role: user.role || '',
  cities: normalizedCities(user.cities)
});

async function listCollection(name) {
  const collection = db.collection(name);
  const countResult = await collection.count();
  const total = countResult.total || 0;
  const pageSize = 100;
  const pages = [];
  for (let skip = 0; skip < total; skip += pageSize) {
    pages.push(collection.skip(skip).limit(pageSize).get());
  }
  const results = await Promise.all(pages);
  return results.flatMap(result => result.data || []);
}

async function listWorkersFor(user, city) {
  if (!hasRole(user, ['admin', 'leader'])) return null;
  const result = await db.collection('users').where({ role: _.in(['worker', 'leader']) }).get();
  const requestedCity = String(city || '').trim();
  const allowedCities = normalizedCities(user.cities);
  return (result.data || []).filter(worker => {
    const workerCities = normalizedCities(worker.cities);
    const matchesRequested = !requestedCity || !workerCities.length || workerCities.some(value => value.includes(requestedCity) || requestedCity.includes(value));
    const matchesLeaderScope = user.role === 'admin' || !allowedCities.length || !workerCities.length || workerCities.some(value => allowedCities.includes(value));
    return matchesRequested && matchesLeaderScope;
  }).map(clientWorker);
}

exports.main = async (event = {}) => {
  const action = event.action || (event.TriggerName ? 'retryNotificationEvents' : '');
  const { orderId, orderIds, userId, groupId, data } = event;
  try {
    if (action === 'getClientPolicy') {
      let policy = DEFAULT_CLIENT_POLICY;
      try {
        const result = await db.collection('system_config').doc('clientPolicy').get();
        if (result.data && typeof result.data === 'object') policy = { ...DEFAULT_CLIENT_POLICY, ...result.data };
      } catch (error) {
        // 首次部署尚未创建配置文档时使用安全默认值，不阻断登录。
        console.warn('读取客户端版本策略失败，使用默认策略：', error.message);
      }
      return { success: true, ...policy };
    }
    const buildNo = Number(event.buildNo || 0);
    const apiSchema = Number(event.apiSchema || 0);
    let policy = DEFAULT_CLIENT_POLICY;
    try {
      const result = await db.collection('system_config').doc('clientPolicy').get();
      if (result.data && typeof result.data === 'object') policy = { ...DEFAULT_CLIENT_POLICY, ...result.data };
    } catch (error) { console.warn('读取客户端版本策略失败，使用默认策略：', error.message); }
    if (apiSchema && apiSchema < Number(policy.apiSchema || 0)) return { success: false, code: 'CLIENT_UPDATE_REQUIRED', policy, msg: policy.message };
    if (WRITE_ACTIONS.has(action) && buildNo && buildNo < Number(policy.minWriteBuild || 0)) return { success: false, code: 'CLIENT_UPDATE_REQUIRED', policy, msg: policy.message };
    const user = event.TriggerName ? { _id: 'system', role: 'admin', isTest: false, name: '系统重试任务' } : await currentUser();
    if (!user) return { success: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新登录' };

    if (action === 'getNotificationConfig') {
      return { success: true, templates: getNotificationConfig(user) };
    }

    if (action === 'getSessionUser') return { success: true, user: clientUser(user) };

    if (action === 'getOrders') {
      const orders = (await listCollection('orders')).filter(order => canAccess(user, order));
      return { success: true, orders };
    }

    if (action === 'getWorkers') {
      const workers = await listWorkersFor(user, data && data.city);
      if (!workers) return { success: false, msg: '仅主管或管理员可获取师傅列表' };
      return { success: true, workers };
    }

    if (action === 'getUsers') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可获取员工列表' };
      const users = await listCollection('users');
      return { success: true, users: users.map(clientUser) };
    }

    if (action === 'getNotificationGroups') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理通知群' };
      // 停用配置也必须可见，管理员才能检查历史配置并重新启用。
      const groups = await listCollection('notification_groups');
      groups.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
      return { success: true, groups: groups.map(normalizeGroup) };
    }

    if (action === 'retryNotificationEvents') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可处理通知重试' };
      const now = new Date().toISOString();
      const result = await db.collection('notification_events').where({ status: _.in(['FAILED', 'PARTIAL']), nextRetryAt: _.lte(now) }).limit(20).get();
      const typeMap = { NEW_ORDER: 'newOrder', FULL_PAYMENT: 'deal', DEPOSIT_PAYMENT: 'deal', ADDITIONAL_PAYMENT: 'deal', FINAL_PAYMENT: 'deal', AMOUNT_CORRECTION: 'deal', ONSITE_FAILED: 'unconverted', SERVICE_CANCELLED: 'unconverted' };
      const output = [];
      for (const event of (result.data || [])) {
        const attempts = Number(event.retryCount || 0);
        if (attempts >= 3) { await db.collection('notification_events').doc(event._id).update({ data: { status: 'RETRY_EXHAUSTED', errorCode: 'RETRY_EXHAUSTED', nextRetryAt: '', updatedAt: now } }); output.push({ eventId: event.eventId, status: 'RETRY_EXHAUSTED' }); continue; }
        const orderResult = await db.collection('orders').doc(event.orderId).get();
        if (!orderResult.data) {
          await db.collection('notification_events').doc(event._id).update({ data: { status: 'PERMANENT_FAILED', errorCode: 'ORDER_NOT_FOUND', nextRetryAt: '', updatedAt: now } });
          output.push({ eventId: event.eventId, status: 'PERMANENT_FAILED' });
          continue;
        }
        let paymentFallback = {};
        if (!event.notificationSnapshot && event.paymentId) {
          const payment = await db.collection('payment_transactions').where({ paymentId: event.paymentId }).limit(1).get();
          const item = payment.data && payment.data[0];
          if (item) paymentFallback = {
            eventType: event.eventType, operationType: item.operationType, amountThisTime: Number(item.amountThisTime || 0),
            paidBefore: Number(item.paidBefore || 0), correctionReason: item.correctionReason || item.note || '',
            paymentChannelCorrected: Number(item.paidBefore || 0) === Number(item.paidAfter || 0) && (
              Number(item.cashBefore || 0) !== Number(item.cashAfter || 0) ||
              Number(item.wechatBefore || 0) !== Number(item.wechatAfter || 0) ||
              Number(item.alipayBefore || 0) !== Number(item.alipayAfter || 0)
            ),
            totalAmount: Number(item.totalAmount || 0), finalAmount: Number(item.paidAfter || 0),
            depositAmount: Number(item.paidAfter || 0), remainingAmount: Number(item.remainingAfter || 0),
            cashAmount: Number(item.cashAfter || 0), wechatAmount: Number(item.wechatAfter || 0), alipayAmount: Number(item.alipayAfter || 0)
          };
        }
        // 优先用写入事件时的不可变快照；订单之后被修改也不会改变原支付通知。
        const notificationOrder = { ...orderResult.data, ...paymentFallback, ...(event.notificationSnapshot || {}), eventId: event.eventId, paymentId: event.paymentId, eventType: event.eventType };
        const notification = await notifyConfiguredGroups(db, typeMap[event.eventType] || 'deal', notificationOrder, { ...user, isTest: event.isTestEvent === true });
        const delay = [60000, 300000, 1800000][attempts] || 1800000;
        await db.collection('notification_events').doc(event._id).update({ data: { retryCount: attempts + 1, status: notification.status || 'FAILED', nextRetryAt: notification.retryable ? new Date(Date.now() + delay).toISOString() : '' } });
        output.push({ eventId: event.eventId, status: notification.status || 'FAILED' });
      }
      return { success: true, results: output };
    }

    if (action === 'createNotificationGroup') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理通知群' };
      const input = data || {};
      const city = String(input.city || '').trim();
      const groupName = String(input.groupName || '').trim();
      const phone = String(input.phone || '').trim();
      const groupType = String(input.groupType || '').trim();
      const webhookUrl = String(input.webhookUrl || '').trim();
      if (!city || !groupName || !/^1\d{10}$/.test(phone) || !['order_entry', 'deal', 'unconverted'].includes(groupType)) return { success: false, msg: '群配置字段不完整或格式错误' };
      try { parseWebhook(webhookUrl); } catch (error) { return { success: false, msg: 'Webhook必须是企业微信官方地址' }; }
      const fingerprint = webhookFingerprint(webhookUrl);
      // 一个企业微信群机器人只对应一个真实群。若复用到其他城市/类型，文字标签
      // 无法改变它实际投递的群，会造成跨城市误发，因此在服务端禁止复用。
      const duplicate = await db.collection('notification_groups').where({ webhookFingerprint: fingerprint, enabled: true }).limit(20).get();
      if (duplicate.data && duplicate.data.length) return { success: false, msg: '该Webhook已绑定其他启用群配置；一个机器人只能对应一个群' };
      const now = new Date().toISOString();
      await db.collection('notification_groups').add({ data: { city, groupName: groupName.slice(0, 30), phone, webhookUrl, webhookFingerprint: fingerprint, groupType, isTestGroup: input.isTestGroup === true, enabled: input.enabled !== false, sort: Number(input.sort || Date.now()), version: 1, createdAt: now, createdBy: user._id, updatedAt: now, updatedBy: user._id } });
      return { success: true };
    }

    if (action === 'updateNotificationGroup') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理通知群' };
      const targetGroupId = groupId || orderId;
      if (!targetGroupId) return { success: false, msg: '缺少群配置ID' };
      const current = await db.collection('notification_groups').doc(targetGroupId).get();
      const group = current.data;
      if (!group) return { success: false, msg: '群配置不存在' };
      if (Number(data && data.version) !== Number(group.version || 1)) return { success: false, code: 'GROUP_VERSION_CONFLICT', msg: '群配置已被其他管理员修改，请刷新后重试' };
      const update = {};
      ['city', 'groupName', 'phone', 'groupType', 'isTestGroup', 'enabled', 'sort'].forEach(key => { if (data[key] !== undefined) update[key] = key === 'groupName' ? String(data[key]).trim().slice(0, 30) : data[key]; });
      if (update.phone !== undefined && !/^1\d{10}$/.test(String(update.phone))) return { success: false, msg: '手机号格式错误' };
      if (update.groupType !== undefined && !['order_entry', 'deal', 'unconverted'].includes(update.groupType)) return { success: false, msg: '群属性无效' };
      if (data.webhookUrl) { try { parseWebhook(data.webhookUrl); } catch (error) { return { success: false, msg: 'Webhook必须是企业微信官方地址' }; } update.webhookUrl = String(data.webhookUrl).trim(); update.webhookFingerprint = webhookFingerprint(update.webhookUrl); }
      const nextFingerprint = update.webhookFingerprint || group.webhookFingerprint;
      const duplicate = await db.collection('notification_groups').where({ webhookFingerprint: nextFingerprint, enabled: true }).limit(20).get();
      if ((duplicate.data || []).some(item => item._id !== targetGroupId)) return { success: false, msg: '该Webhook已绑定其他启用群配置；一个机器人只能对应一个群' };
      const now = new Date().toISOString();
      update.version = Number(group.version || 1) + 1; update.updatedAt = now; update.updatedBy = user._id;
      const result = await db.collection('notification_groups').where({ _id: targetGroupId, version: Number(data.version) }).update({ data: update });
      if (!result.stats || result.stats.updated !== 1) return { success: false, code: 'GROUP_VERSION_CONFLICT', msg: '群配置已被其他管理员修改，请刷新后重试' };
      return { success: true };
    }

    if (action === 'deleteNotificationGroup') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理通知群' };
      const targetGroupId = groupId || orderId;
      if (!targetGroupId) return { success: false, msg: '缺少群配置ID' };
      const version = Number(data && data.version);
      const now = new Date().toISOString();
      const result = await db.collection('notification_groups').where({ _id: targetGroupId, version }).update({ data: { enabled: false, deletedAt: now, deletedBy: user._id, updatedAt: now, updatedBy: user._id, version: version + 1 } });
      if (!result.stats || result.stats.updated !== 1) return { success: false, code: 'GROUP_VERSION_CONFLICT', msg: '群配置已被其他管理员修改，请刷新后重试' };
      return { success: true };
    }

    if (action === 'createUser') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可录入员工' };
      const name = String(data && data.name || '').trim();
      const phone = String(data && data.phone || '').trim();
      const role = String(data && data.role || 'worker');
      const cities = normalizedCities(data && data.cities);
      if (!name) return { success: false, msg: '请输入姓名' };
      if (!/^\d{11}$/.test(phone)) return { success: false, msg: '请输入11位手机号' };
      if (!['leader', 'service', 'worker'].includes(role)) return { success: false, msg: '员工角色无效' };
      if (!cities.length) return { success: false, msg: '请至少分配一个城市' };
      const existing = await db.collection('users').where({ phone }).limit(1).get();
      if (existing.data && existing.data.length) return { success: false, msg: '该手机号已被其他员工使用' };
      await db.collection('users').add({ data: {
        name, phone, role, cities,
        isTest: Boolean(data && data.isTest),
        openid: '',
        createTime: new Date().toISOString()
      } });
      return { success: true };
    }

    if (action === 'createSource' || action === 'deleteSource') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理渠道' };
      if (action === 'createSource') {
        const name = String(data && data.name || '').trim();
        if (!name) return { success: false, msg: '请输入渠道名称' };
        const existing = await db.collection('order_sources').where({ name }).limit(1).get();
        if (existing.data && existing.data.length) return { success: false, msg: '该渠道已存在' };
        await db.collection('order_sources').add({ data: { name, sort: Date.now(), enabled: true, createTime: new Date().toISOString() } });
      } else {
        const sourceId = String(data && data.sourceId || '').trim();
        if (!sourceId) return { success: false, msg: '缺少渠道ID' };
        await db.collection('order_sources').doc(sourceId).remove();
      }
      return { success: true };
    }

    if (action === 'createOrder') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无录单权限' };
      const validationError = validateCreateOrder(data);
      if (validationError) return { success: false, msg: validationError };
      const wantsAssignment = Boolean(data && (data.workerName || data.workerPhone));
      if (user.role !== 'leader' && wantsAssignment) return { success: false, msg: '客服录单后请由主管派单' };
      const createFields = ['city', 'customerPhone', 'address', 'appointmentTime', 'source', 'totalAmount', 'paidAmount', 'pendingBalance', 'feedbacks'];
      if (user.role === 'leader') createFields.push(...fields.assign);
      const payload = pick(data, createFields);
      if (Array.isArray(payload.feedbacks)) {
        payload.feedbacks = payload.feedbacks.map(item => ({
          id: item.id || `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          time: item.time || new Date().toISOString(),
          timeFormatted: item.timeFormatted || item.time || '',
          operatorName: String(item.operatorName || item.author || user.name || '客服').trim(),
          operatorRole: item.operatorRole || user.role || 'service',
          content: String(item.content || '').trim(),
          photos: Array.isArray(item.photos) ? item.photos : (Array.isArray(item.images) ? item.images : [])
        })).filter(item => item.content);
      }
      const cities = Array.isArray(user.cities) ? user.cities : [];
      if (payload.city && cities.length && !cities.includes(payload.city)) return { success: false, msg: '无权录入该城市工单' };
      if (user.role === 'leader' && wantsAssignment) {
        const assigned = await findAssignableWorker(payload.workerPhone);
        if (assigned.error) return { success: false, msg: assigned.error };
        if (!canServeCity(assigned.worker, payload.city)) return { success: false, msg: '该师傅不负责此城市，不能派单' };
        // 姓名仅作展示，必须以后端手机号查到的员工资料为准。
        payload.workerName = assigned.worker.name || '';
        payload.workerPhone = assigned.worker.phone;
      }
      Object.assign(payload, { creatorName: user.name, createTime: new Date().toISOString(), status: payload.workerName ? '已派单' : '待派单' });
      const createdAt = new Date().toISOString();
      const result = await createOrderEventTransaction(payload, { eventType: 'NEW_ORDER', groupType: 'order_entry', city: payload.city, operationId: '', actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', createdAt, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
      const eventId = 'evt_' + result._id;
      let notification;
      try {
        notification = await notifyConfiguredGroups(db, 'newOrder', { ...payload, _id: result._id, eventId }, user);
      } catch (notificationError) {
        console.error('新工单已保存，但群通知处理失败：', eventId, notificationError.message);
        notification = { success: false, status: 'FAILED', code: 'NOTIFICATION_PROCESSING_FAILED' };
        try {
          await db.collection('notification_events').where({ eventId }).update({ data: { status: 'FAILED', errorCode: notification.code, updatedAt: new Date().toISOString() } });
        } catch (eventUpdateError) {
          console.error('新工单通知事件状态更新失败：', eventId, eventUpdateError.message);
        }
      }
      return { success: true, orderId: result._id, eventId, notification };
    }

    if (action === 'batchAssignWorker') {
      if (!hasRole(user, ['leader'])) return { success: false, msg: '仅主管可批量派单' };
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 100) return { success: false, msg: '工单列表无效' };
      const targetOrders = await db.collection('orders').where({ _id: _.in(orderIds) }).get();
      const requested = new Set(orderIds);
      const found = (targetOrders.data || []).filter(order => requested.has(order._id));
      if (found.length !== requested.size || found.some(order => !canAccess(user, order))) {
        return { success: false, msg: '含有无权操作的工单' };
      }
      const assigned = await findAssignableWorker(data && data.workerPhone);
      if (assigned.error) return { success: false, msg: assigned.error };
      if (found.some(order => !canServeCity(assigned.worker, order.city))) return { success: false, msg: '该师傅不负责其中部分工单所在城市，不能批量派单' };
      const result = await db.collection('orders').where({ _id: _.in(orderIds), status: _.nin(['已完工', '未成单']) }).update({
        data: { workerName: assigned.worker.name || '', workerPhone: assigned.worker.phone, status: '已派单', assignTime: new Date().toISOString() }
      });
      return { success: true, updated: result.stats && result.stats.updated };
    }

    if (action === 'updateUser' || action === 'unbindUser') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理员工' };
      if (!userId) return { success: false, msg: '缺少员工ID' };
      if (action === 'unbindUser') {
        if (userId === user._id) return { success: false, msg: '不能解绑当前登录账号' };
        await db.collection('users').doc(userId).update({ data: { openid: '' } });
      }
      else {
        const payload = pick(data, ['name', 'phone', 'role', 'cities', 'isTest']);
        if (payload.role && !['admin', 'leader', 'service', 'worker'].includes(payload.role)) return { success: false, msg: '角色无效' };
        if (payload.isTest !== undefined) payload.isTest = Boolean(payload.isTest);
        if (payload.phone !== undefined) {
          payload.phone = String(payload.phone).trim();
          if (!/^\d{11}$/.test(payload.phone)) return { success: false, msg: '请输入11位手机号' };
          const conflict = await db.collection('users').where({ phone: payload.phone }).limit(1).get();
          if (conflict.data && conflict.data.some(item => item._id !== userId)) return { success: false, msg: '该手机号已被其他员工使用' };
        }
        if (payload.cities !== undefined) payload.cities = normalizedCities(payload.cities);
        await db.collection('users').doc(userId).update({ data: payload });
      }
      return { success: true };
    }

    if (!orderId) return { success: false, msg: '缺少订单ID' };
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order || !canAccess(user, order)) return { success: false, msg: '无权访问该工单' };

    if (action === 'getOrderDetail') return { success: true, order };

    // 只解析云端工单地址；客户端不能指定任意地址，也不能绕过工单权限。
    if (action === 'getOrderLocation') return await resolveOrderLocation(order);

    if (action === 'updateOrder') {
      if (!hasRole(user, ['leader'])) return { success: false, msg: '仅主管可派单' };
      if (['已完工', '未成单'].includes(order.status)) return { success: false, msg: '归档工单不可改派' };
      const assigned = await findAssignableWorker(data && data.workerPhone);
      if (assigned.error) return { success: false, msg: assigned.error };
      if (!canServeCity(assigned.worker, order.city)) return { success: false, msg: '该师傅不负责此城市，不能派单' };
      await db.collection('orders').doc(orderId).update({ data: { workerName: assigned.worker.name || '', workerPhone: assigned.worker.phone, status: '已派单', assignTime: new Date().toISOString() } });
    } else if (action === 'urgent') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无催单权限' };
      if (['已完工', '未成单'].includes(order.status)) return { success: false, msg: '归档工单不可催单' };
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - 60000).toISOString();
      const claim = await db.collection('orders').where(_.and([
        { _id: orderId, status: _.nin(['已完工', '未成单']) },
        _.or([{ urgentTime: _.exists(false) }, { urgentTime: '' }, { urgentTime: _.lt(cutoff) }])
      ])).update({ data: { isUrgent: true, urgentTime: now } });
      if (!claim.stats || claim.stats.updated !== 1) return { success: false, msg: '请勿重复催单，请稍后再试' };
      return { success: true, msg: '催单状态已更新' };
    } else if (action === 'editTime') {
      if (!hasRole(user, ['service', 'leader', 'worker'])) return { success: false, msg: '无改期权限' };
      if (['已完工', '未成单'].includes(order.status)) return { success: false, msg: '归档工单不可改期' };
      if (!data || typeof data.appointmentTime !== 'string' || !data.appointmentTime.trim()) return { success: false, msg: '请输入预约时间' };
      await db.collection('orders').doc(orderId).update({ data: pick(data, fields.editTime) });
    } else if (action === 'cancelOrder') {
      // 客服退单只能由客服发起；归档订单不能被重新改成未成单。
      if (!hasRole(user, ['service'])) return { success: false, msg: '仅客服可取消工单' };
      if (ARCHIVED_STATUSES.includes(order.status)) return { success: false, msg: '归档工单不可取消' };
      const reason = String(data && data.cancelReason || '').trim();
      if (!reason) return { success: false, msg: '请填写取消原因' };
      const now = new Date().toISOString();
      const feedback = {
        id: `fb_${Date.now()}`,
        time: now,
        operatorName: user.name || '客服',
        operatorRole: 'service',
        content: `[客服退单取消] 理由：${reason}`,
        photos: []
      };
      const orderUpdate = {
        status: '未成单',
        uncompletedType: 'service_cancel',
        cancelReason: reason,
        cancelOperator: user.name || '客服',
        cancelTime: now,
        feedbacks: [feedback, ...(Array.isArray(order.feedbacks) ? order.feedbacks : [])],
        isUrgent: false
      };
      await commitOrderEventTransaction(orderId, orderUpdate, { eventId: 'evt_' + orderId + '_service_cancel', eventKey: `order:${orderId}:unconverted:service_cancel`, orderId, eventType: 'SERVICE_CANCELLED', groupType: 'unconverted', city: order.city, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
      await notifyConfiguredGroups(db, 'unconverted', { ...order, status: '未成单', uncompletedType: 'service_cancel', cancelReason: reason, eventId: 'evt_' + orderId + '_service_cancel' }, user);
    } else if (action === 'failOrder') {
      // 现场未成单不是派单操作：只允许该单师傅或主管，并在云端生成留痕。
      if (!canSettle(user, order)) return { success: false, msg: '仅负责该单的师傅或主管可标记未成单' };
      if (ARCHIVED_STATUSES.includes(order.status)) return { success: false, msg: '归档工单不可标记未成单' };
      const reason = String(data && data.failReason || '').trim();
      if (!reason) return { success: false, msg: '请填写未成单原因' };
      const now = new Date().toISOString();
      const feedback = {
        id: `fb_${Date.now()}`,
        time: now,
        operatorName: user.name || (user.role === 'leader' ? '主管' : '师傅'),
        operatorRole: user.role === 'leader' ? 'leader' : 'worker',
        content: `[现场标记未成单] 理由：${reason}`,
        photos: []
      };
      const orderUpdate = {
        status: '未成单',
        uncompletedType: 'worker_fail',
        failReason: reason,
        failOperator: feedback.operatorName,
        failTime: now,
        feedbacks: [feedback, ...(Array.isArray(order.feedbacks) ? order.feedbacks : [])],
        isUrgent: false
      };
      await commitOrderEventTransaction(orderId, orderUpdate, { eventId: 'evt_' + orderId + '_worker_fail', eventKey: `order:${orderId}:unconverted:worker_fail`, orderId, eventType: 'ONSITE_FAILED', groupType: 'unconverted', city: order.city, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
      await notifyConfiguredGroups(db, 'unconverted', { ...order, status: '未成单', failReason: reason, eventId: 'evt_' + orderId + '_worker_fail' }, user);
    } else if (action === 'finishOrder') {
      if (!canSettle(user, order)) return { success: false, msg: '无结算权限' };
      if (order.status === '未成单') return { success: false, msg: '未成单不可结算' };
      const validationError = validateSettlement(data);
      if (validationError) return { success: false, msg: validationError };
      const operationId = String(data.operationId || '').trim();
      if (!operationId) return { success: false, msg: '缺少操作流水号，请重试' };
      const duplicate = await db.collection('payment_transactions').where({ orderId, operationId }).limit(1).get().catch(() => ({ data: [] }));
      if (duplicate.data && duplicate.data[0]) return { success: true, duplicate: true, paymentId: duplicate.data[0].paymentId, msg: '订单已保存，未重复入账' };
      const beforePaid = Number(order.finalAmount || order.depositAmount || 0);
      const after = pick(data, fields.finish);
      const afterPaid = Number(after.finalAmount || after.depositAmount || 0);
      const operationType = String(data.operationType || '').trim();
      const channelPaid = ['cashAmount', 'wechatAmount', 'alipayAmount'].reduce((sum, key) => sum + Number(after[key] || 0), 0);
      if (Math.abs(channelPaid - afterPaid) > 0.01) return { success: false, msg: '累计实收必须等于现金、微信和支付宝金额之和' };
      const channelsChanged = Number(order.cashAmount || 0) !== Number(after.cashAmount || 0) || Number(order.wechatAmount || 0) !== Number(after.wechatAmount || 0) || Number(order.alipayAmount || 0) !== Number(after.alipayAmount || 0);
      const amountChanged = beforePaid !== afterPaid || channelsChanged || Number(order.totalAmount || 0) !== Number(after.totalAmount || 0) || Number(order.remainingAmount || 0) !== Number(after.remainingAmount || 0);
      if (!amountChanged) {
        await db.collection('orders').doc(orderId).update({ data: after });
        return { success: true, notification: { success: true, status: 'SUPPRESSED', msg: '仅更新照片或备注，未产生支付通知' } };
      }
      const isCorrection = operationType === 'amount_correction' || order.status === '已完工';
      if (isCorrection && !String(data.correctionReason || data.note || '').trim()) return { success: false, msg: '金额修正必须填写原因' };
      const validTypes = ['full_payment', 'deposit_payment', 'additional_payment', 'final_payment', 'amount_correction'];
      if (!validTypes.includes(operationType)) return { success: false, msg: '收款操作类型无效' };
      const expectedType = isCorrection ? 'amount_correction' : (beforePaid <= 0 ? (Number(after.remainingAmount || 0) === 0 ? 'full_payment' : 'deposit_payment') : (Number(after.remainingAmount || 0) === 0 ? 'final_payment' : 'additional_payment'));
      if (operationType !== expectedType) return { success: false, msg: '收款操作类型与订单金额状态不一致' };
      // 本次收款只能由服务端根据前后累计实收计算，绝不采用客户端 amountThisTime。
      const amountThisTime = isCorrection ? 0 : Number((afterPaid - beforePaid).toFixed(2));
      if (!isCorrection && amountThisTime <= 0) return { success: false, msg: '本次收款金额必须大于0' };
      const paymentId = 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const now = new Date().toISOString();
      after.paymentLogs = [{ id: paymentId, time: now, operatorName: user.name || '', operatorRole: user.role, settleType: after.settleType, currentPaid: isCorrection ? afterPaid : amountThisTime, paidBefore: beforePaid, paidAfter: afterPaid, amountThisTime, totalAmount: after.totalAmount, remainingAmount: after.remainingAmount, cashAmount: after.cashAmount, wechatAmount: after.wechatAmount, alipayAmount: after.alipayAmount, note: data.note || data.correctionReason || '', photos: after.finishPhotos || [] }, ...(Array.isArray(order.paymentLogs) ? order.paymentLogs : [])];
      const eventType = isCorrection ? 'AMOUNT_CORRECTION' : (operationType === 'full_payment' ? 'FULL_PAYMENT' : (operationType === 'deposit_payment' ? 'DEPOSIT_PAYMENT' : (operationType === 'final_payment' ? 'FINAL_PAYMENT' : 'ADDITIONAL_PAYMENT')));
      const paymentData = { paymentId, operationId, orderId, operationType, paidBefore: beforePaid, amountThisTime, paidAfter: afterPaid, totalAmount: Number(after.totalAmount || afterPaid), remainingBefore: Number(order.remainingAmount || 0), remainingAfter: Number(after.remainingAmount || 0), cashBefore: Number(order.cashAmount || 0), cashAfter: Number(after.cashAmount || 0), wechatBefore: Number(order.wechatAmount || 0), wechatAfter: Number(after.wechatAmount || 0), alipayBefore: Number(order.alipayAmount || 0), alipayAfter: Number(after.alipayAmount || 0), correctionReason: String(data.correctionReason || ''), note: String(data.note || ''), operatorId: user._id, operatorName: user.name || '', operatorRole: user.role, createdAt: now };
      const notificationSnapshot = paymentNotificationSnapshot(order, after, { eventType, operationType, amountThisTime, paidBefore: beforePaid, paymentChannelCorrected: channelsChanged && beforePaid === afterPaid, correctionReason: String(data.correctionReason || data.note || '') });
      const eventData = { eventId: 'evt_' + paymentId, eventKey: `order:${orderId}:payment:${paymentId}`, orderId, eventType, groupType: 'deal', city: order.city, paymentId, operationId, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, notificationSnapshot, status: 'PENDING', createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
      await commitPaymentTransaction(orderId, after, paymentData, eventData);
      let notification;
      try {
        notification = await notifyConfiguredGroups(db, 'deal', { ...order, ...notificationSnapshot, paymentId, eventId: 'evt_' + paymentId }, user);
      } catch (notificationError) {
        console.error('支付已提交，但群通知处理失败：', notificationError.message);
        notification = { success: false, status: 'FAILED', code: 'NOTIFICATION_PROCESSING_FAILED', msg: '订单已保存，群通知未确认' };
      }
      return { success: true, paymentId, notification };
    } else if (action === 'feedback') {
      if (!hasRole(user, ['service', 'leader', 'worker'])) return { success: false, msg: '无回馈权限' };
      await db.collection('orders').doc(orderId).update({ data: pick(data, fields.feedback) });
    } else return { success: false, msg: '未知操作类型' };
    return { success: true };
  } catch (err) {
    console.error('云函数处理异常：', err);
    return { success: false, msg: '云端处理失败', error: err.message || String(err) };
  }
};
