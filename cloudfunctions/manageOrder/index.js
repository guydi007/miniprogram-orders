const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { parseWebhook } = require('./groupNotifications');
const { notifyAll, getNotificationConfig } = require('./notifications');
const { resolveOrderLocation } = require('./orderLocation');

const fields = {
  assign: ['workerName', 'workerPhone', 'workerGroupId'],
  editTime: ['appointmentTime', 'appointmentLogs', 'feedbacks', 'isUrgent'],
  finish: ['status', 'settleType', 'cashAmount', 'wechatAmount', 'alipayAmount', 'finalAmount', 'depositAmount', 'totalAmount', 'remainingAmount', 'companionWorkers', 'finishPhotos', 'finishNote', 'paymentLogs', 'isUrgent', 'finishTime'],
  feedback: ['feedbacks']
};

const ARCHIVED_STATUSES = ['已完工', '未成单'];

function pick(value, allowed) {
  const out = {};
  const input = value && typeof value === 'object' ? value : {};
  allowed.forEach(key => { if (input[key] !== undefined) out[key] = input[key]; });
  return out;
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
  user && order && (hasRole(user, ['leader']) || (user.role === 'worker' && order.workerName === user.name))
);
const canAccess = (user, order) => {
  if (user.role === 'admin') return true;
  if (user.role === 'worker') return order.workerName === user.name;
  const cities = Array.isArray(user.cities) ? user.cities : [];
  return !order.city || cities.includes(order.city);
};

const normalizedCities = value => {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim());
  if (value && typeof value === 'object') return Object.values(value).filter(item => typeof item === 'string' && item.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
};

const clientUser = user => ({
  _id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  role: user.role || '',
  cities: normalizedCities(user.cities),
  groupId: user.groupId || '',
  isTest: Boolean(user.isTest),
  webhookUrl: user.webhookUrl || '',
  // 前端仅需判断是否已经绑定，不能获得真实 openid 或测试会话。
  openid: Boolean(user.openid)
});

const clientWorker = user => ({
  _id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  role: user.role || '',
  cities: normalizedCities(user.cities),
  groupId: user.groupId || ''
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
  const { action, orderId, orderIds, userId, data } = event;
  try {
    const user = await currentUser();
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
        groupId: role === 'worker' ? String(data && data.groupId || '').trim() : '',
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
      const wantsAssignment = Boolean(data && (data.workerName || data.workerPhone || data.workerGroupId));
      if (user.role !== 'leader' && wantsAssignment) return { success: false, msg: '客服录单后请由主管派单' };
      const createFields = ['city', 'customerPhone', 'address', 'appointmentTime', 'source', 'totalAmount', 'paidAmount', 'pendingBalance', 'feedbacks'];
      if (user.role === 'leader') createFields.push(...fields.assign);
      const payload = pick(data, createFields);
      const cities = Array.isArray(user.cities) ? user.cities : [];
      if (payload.city && cities.length && !cities.includes(payload.city)) return { success: false, msg: '无权录入该城市工单' };
      Object.assign(payload, { creatorName: user.name, createTime: new Date().toISOString(), status: payload.workerName ? '已派单' : '待派单' });
      const result = await db.collection('orders').add({ data: payload });
      const notification = await notifyAll(cloud, db, 'newOrder', { ...payload, _id: result._id }, user);
      return { success: true, orderId: result._id, notification };
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
      const result = await db.collection('orders').where({ _id: _.in(orderIds), status: _.nin(['已完工', '未成单']) }).update({
        data: { ...pick(data, fields.assign), status: '已派单', assignTime: new Date().toISOString() }
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
        const payload = pick(data, ['name', 'phone', 'role', 'cities', 'groupId', 'isTest', 'webhookUrl']);
        if (payload.webhookUrl !== undefined) {
          payload.webhookUrl = String(payload.webhookUrl || '').trim();
          if (payload.webhookUrl) {
            try { parseWebhook(payload.webhookUrl); } catch (error) { return { success: false, msg: error.message }; }
          }
        }
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
      await db.collection('orders').doc(orderId).update({ data: { ...pick(data, fields.assign), status: '已派单', assignTime: new Date().toISOString() } });
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
      const notification = await notifyAll(cloud, db, 'urgent', order, user);
      return { success: true, notification };
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
      const result = await db.collection('orders').where({
        _id: orderId,
        status: _.nin(ARCHIVED_STATUSES)
      }).update({ data: {
        status: '未成单',
        uncompletedType: 'service_cancel',
        cancelReason: reason,
        cancelOperator: user.name || '客服',
        cancelTime: now,
        feedbacks: [feedback, ...(Array.isArray(order.feedbacks) ? order.feedbacks : [])],
        isUrgent: false
      } });
      if (!result.stats || result.stats.updated !== 1) return { success: false, msg: '工单状态已变化，请刷新后重试' };
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
      const result = await db.collection('orders').where({
        _id: orderId,
        status: _.nin(ARCHIVED_STATUSES)
      }).update({ data: {
        status: '未成单',
        uncompletedType: 'worker_fail',
        failReason: reason,
        failOperator: feedback.operatorName,
        failTime: now,
        feedbacks: [feedback, ...(Array.isArray(order.feedbacks) ? order.feedbacks : [])],
        isUrgent: false
      } });
      if (!result.stats || result.stats.updated !== 1) return { success: false, msg: '工单状态已变化，请刷新后重试' };
    } else if (action === 'finishOrder') {
      if (!canSettle(user, order)) return { success: false, msg: '无结算权限' };
      if (order.status === '未成单') return { success: false, msg: '未成单不可结算' };
      await db.collection('orders').doc(orderId).update({ data: pick(data, fields.finish) });
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
