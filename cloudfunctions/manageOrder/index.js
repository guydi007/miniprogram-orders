const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { parseWebhook, normalizeGroup, webhookFingerprint, notifyConfiguredGroups } = require('./groupNotifications');
const { notifyAll, getNotificationConfig } = require('./notifications');
const { resolveOrderLocation } = require('./orderLocation');

const DEFAULT_CLIENT_POLICY = { latestBuild: 20400, minWriteBuild: 0, minReadBuild: 0, apiSchema: 2, forceAfter: '', message: '请升级到最新版本' };
const WRITE_ACTIONS = new Set(['createOrder', 'assignWorker', 'batchAssignWorker', 'updateOrder', 'urgent', 'editTime', 'finishOrder', 'cancelOrder', 'failOrder', 'feedback', 'createUser', 'updateUser', 'unbindUser', 'createSource', 'deleteSource', 'createNotificationGroup', 'updateNotificationGroup', 'deleteNotificationGroup', 'trackUploadedFiles', 'confirmUploadedFiles', 'untrackUploadedFiles']);

const fields = {
  assign: ['workerId', 'workerName', 'workerPhone'],
  editTime: ['appointmentTime', 'appointmentLogs', 'feedbacks', 'isUrgent'],
  finish: ['status', 'settleType', 'cashAmount', 'wechatAmount', 'alipayAmount', 'finalAmount', 'depositAmount', 'totalAmount', 'remainingAmount', 'companionWorkers', 'finishPhotos', 'finishNote', 'paymentLogs', 'isUrgent'],
  feedback: ['feedbacks']
};

const ARCHIVED_STATUSES = ['已完工', '未成单'];

function paymentNotificationSnapshot(order, after, details) {
  return {
    city: order.city || '', customerPhone: order.customerPhone || '', address: order.address || '',
    appointmentTime: order.appointmentTime || '', workerId: order.workerId || '', workerName: order.workerName || '', source: order.source || '',
    creatorId: order.creatorId || '', creatorName: order.creatorName || '', feedbacks: after.feedbacks || order.feedbacks || [],
    finishNote: after.finishNote || order.finishNote || '', status: after.status || order.status || '',
    totalAmount: Number(after.totalAmount || 0), finalAmount: Number(after.finalAmount || 0),
    depositAmount: Number(after.depositAmount || 0), remainingAmount: Number(after.remainingAmount || 0),
    cashAmount: Number(after.cashAmount || 0), wechatAmount: Number(after.wechatAmount || 0), alipayAmount: Number(after.alipayAmount || 0),
    eventType: details.eventType, operationType: details.operationType, amountThisTime: details.amountThisTime,
    paidBefore: details.paidBefore, paymentChannelCorrected: details.paymentChannelCorrected,
    correctionReason: details.correctionReason || ''
  };
}

async function commitPaymentTransaction(orderId, expectedVersion, orderData, paymentData, eventData) {
  const transaction = await db.startTransaction();
  try {
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected) || expected < 0) throw makeOrderError('INVALID_ORDER_VERSION', '订单版本号无效，请刷新后重试');
    const latest = await transaction.collection('orders').doc(orderId).get();
    const currentVersion = Number(latest.data && latest.data.version || 0);
    if (!latest.data || currentVersion !== expected) {
      throw makeOrderError('ORDER_VERSION_CONFLICT', '订单已被其他操作更新，请刷新后重试');
    }
    await transaction.collection('orders').doc(orderId).update({ data: { ...orderData, version: currentVersion + 1 } });
    await transaction.collection('payment_transactions').add({ data: paymentData });
    await transaction.collection('notification_events').add({ data: eventData });
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('支付事务回滚失败：', rollbackError.message); }
    throw error;
  }
}

function makeOrderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readExpectedVersion(event, data) {
  const source = data && data.expectedVersion !== undefined ? data.expectedVersion : event.expectedVersion;
  if (source === undefined || source === null || source === '') return null;
  const version = Number(source);
  if (!Number.isInteger(version) || version < 0) return NaN;
  return version;
}

async function commitOrderMutation(orderId, options = {}) {
  const transaction = await db.startTransaction();
  try {
    const latest = await transaction.collection('orders').doc(orderId).get();
    const current = latest.data;
    if (!current) throw makeOrderError('ORDER_NOT_FOUND', '工单不存在');

    const expectedVersion = options.expectedVersion;
    const currentVersion = Number(current.version || 0);
    if (Number.isNaN(expectedVersion)) throw makeOrderError('INVALID_ORDER_VERSION', '订单版本号无效，请刷新后重试');
    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      throw makeOrderError('ORDER_VERSION_CONFLICT', '订单已被其他操作更新，请刷新后重试');
    }
    if (options.user && !canAccess(options.user, current)) {
      throw makeOrderError('ORDER_ACCESS_DENIED', '无权访问该工单');
    }

    const mutation = await options.mutate(current, currentVersion);
    const patch = mutation && mutation.patch ? mutation.patch : {};
    const nextVersion = currentVersion + 1;
    await transaction.collection('orders').doc(orderId).update({ data: { ...patch, version: nextVersion } });
    if (mutation && mutation.eventData) {
      await transaction.collection('notification_events').add({ data: mutation.eventData });
    }
    await transaction.commit();
    return {
      before: current,
      after: { ...current, ...patch, version: nextVersion },
      result: mutation && mutation.result
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('订单事务回滚失败：', rollbackError.message); }
    throw error;
  }
}

function mutationErrorResponse(error) {
  if (['ORDER_VERSION_CONFLICT', 'INVALID_ORDER_VERSION', 'ORDER_NOT_FOUND', 'ORDER_ACCESS_DENIED', 'ORDER_ARCHIVED', 'ORDER_STATE_CHANGED'].includes(error.code)) {
    return { success: false, code: error.code, msg: error.message };
  }
  return null;
}

function normalizePhotos(value, max = 9) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.trim()).slice(0, max);
}

function feedbackInput(data, user) {
  const input = data && typeof data === 'object' ? data : {};
  const first = Array.isArray(input.feedbacks) && input.feedbacks.length ? input.feedbacks[0] : null;
  const source = input.feedback && typeof input.feedback === 'object' ? input.feedback : (first || input);
  const content = String(source.content || '').trim();
  return {
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    operatorName: user.name || '员工',
    operatorRole: user.role || 'worker',
    content: content.slice(0, 2000),
    photos: normalizePhotos(source.photos || source.images, 9)
  };
}

function createOperationDocId(createOperationId) {
  return 'create_' + crypto.createHash('sha256').update(String(createOperationId || '')).digest('hex').slice(0, 40);
}

async function getCreateOperation(createOperationId) {
  const operationId = createOperationDocId(createOperationId);
  const result = await db.collection('order_operations').doc(operationId).get().catch(() => ({ data: null }));
  return result.data || null;
}

async function createOrderEventTransaction(createOperationId, orderData, eventBase, actor) {
  const operationDocId = createOperationDocId(createOperationId);
  const transaction = await db.startTransaction();
  try {
    const existingOperation = await transaction.collection('order_operations').doc(operationDocId).get().catch(() => ({ data: null }));
    if (existingOperation.data) {
      const existing = existingOperation.data;
      if (String(existing.creatorId || '') !== String(actor._id || '')) {
        throw makeOrderError('CREATE_OPERATION_ID_CONFLICT', '录单请求标识冲突，请重新进入录单页面');
      }
      await transaction.rollback();
      return { _id: existing.orderId, duplicate: true };
    }

    const result = await transaction.collection('orders').add({ data: orderData });
    const eventId = 'evt_' + result._id;
    await transaction.collection('order_operations').doc(operationDocId).set({ data: {
      createOperationId,
      orderId: result._id,
      creatorId: actor._id,
      createdAt: orderData.createTime || new Date().toISOString()
    } });
    await transaction.collection('notification_events').add({ data: {
      ...eventBase,
      orderId: result._id,
      eventId,
      eventKey: `order:${result._id}:created`
    } });
    await transaction.commit();
    return { ...result, duplicate: false };
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('新订单事务回滚失败'); }

    // 并发重试时，另一事务可能已成功写入同一个操作登记。此时按幂等成功返回。
    const existing = await getCreateOperation(createOperationId).catch(() => null);
    if (existing) {
      if (String(existing.creatorId || '') === String(actor._id || '') && existing.orderId) {
        return { _id: existing.orderId, duplicate: true };
      }
      if (String(existing.creatorId || '') !== String(actor._id || '')) {
        throw makeOrderError('CREATE_OPERATION_ID_CONFLICT', '录单请求标识冲突，请重新进入录单页面');
      }
    }
    throw error;
  }
}

function feedbackOperationDocId(operationId) {
  return 'feedback_' + crypto.createHash('sha256').update(String(operationId || '')).digest('hex').slice(0, 40);
}

async function getFeedbackOperation(operationId) {
  const result = await db.collection('order_operations').doc(feedbackOperationDocId(operationId)).get().catch(() => ({ data: null }));
  return result.data || null;
}

async function commitFeedbackTransaction(orderId, expectedVersion, operationId, feedback, user) {
  const operationDocId = feedbackOperationDocId(operationId);
  const transaction = await db.startTransaction();
  try {
    const existingOperation = await transaction.collection('order_operations').doc(operationDocId).get().catch(() => ({ data: null }));
    if (existingOperation.data) {
      const existing = existingOperation.data;
      if (String(existing.orderId || '') !== String(orderId) || String(existing.actorId || '') !== String(user._id || '')) {
        throw makeOrderError('FEEDBACK_OPERATION_ID_CONFLICT', '回馈请求标识冲突，请重新打开回馈窗口');
      }
      await transaction.rollback();
      return { duplicate: true, version: Number(existing.resultVersion || 0), feedbackId: existing.feedbackId || '' };
    }

    const latest = await transaction.collection('orders').doc(orderId).get();
    const current = latest.data;
    if (!current) throw makeOrderError('ORDER_NOT_FOUND', '工单不存在');
    if (!canAccess(user, current)) throw makeOrderError('ORDER_ACCESS_DENIED', '无权访问该工单');
    const currentVersion = Number(current.version || 0);
    if (Number.isNaN(expectedVersion)) throw makeOrderError('INVALID_ORDER_VERSION', '订单版本号无效，请刷新后重试');
    if (expectedVersion !== null && currentVersion !== expectedVersion) throw makeOrderError('ORDER_VERSION_CONFLICT', '订单已被其他操作更新，请刷新后重试');

    const nextVersion = currentVersion + 1;
    await transaction.collection('orders').doc(orderId).update({ data: {
      feedbacks: [feedback, ...(Array.isArray(current.feedbacks) ? current.feedbacks : [])],
      version: nextVersion
    } });
    await transaction.collection('order_operations').doc(operationDocId).set({ data: {
      operationType: 'feedback', operationId, orderId, actorId: user._id,
      feedbackId: feedback.id, resultVersion: nextVersion, createdAt: feedback.time || new Date().toISOString()
    } });
    await transaction.commit();
    return { duplicate: false, version: nextVersion, feedbackId: feedback.id };
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { /* ignore */ }
    const existing = await getFeedbackOperation(operationId).catch(() => null);
    if (existing && String(existing.orderId || '') === String(orderId) && String(existing.actorId || '') === String(user._id || '')) {
      return { duplicate: true, version: Number(existing.resultVersion || 0), feedbackId: existing.feedbackId || '' };
    }
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
  for (const [key, label] of [['city', '服务城市'], ['customerPhone', '客户电话'], ['address', '服务地址'], ['appointmentTime', '预约时间']]) {
    if (!String(input[key] || '').trim()) return `请填写${label}`;
  }
  if (!/^1\d{10}$/.test(String(input.customerPhone).trim())) return '客户电话格式不正确';
  if (input.totalAmount !== undefined && (!Number.isFinite(Number(input.totalAmount)) || Number(input.totalAmount) < 0)) return '工程金额不正确';
  return '';
}

function validateSettlement(data, options = {}) {
  const input = data && typeof data === 'object' ? data : {};
  const allowZeroPaid = options.allowZeroPaid === true;
  const keys = ['cashAmount', 'wechatAmount', 'alipayAmount'];
  for (const key of keys) if (!Number.isFinite(Number(input[key] || 0)) || Number(input[key] || 0) < 0) return '收款金额不正确';
  const paid = keys.reduce((sum, key) => sum + Number(input[key] || 0), 0);
  if ((!allowZeroPaid && paid <= 0) || (allowZeroPaid && paid < 0)) return '请输入至少一项收款金额';
  const finalAmount = Number(input.finalAmount !== undefined ? input.finalAmount : input.depositAmount);
  const total = Number(input.totalAmount === undefined || input.totalAmount === '' ? paid : input.totalAmount);
  const remain = Number(input.remainingAmount === undefined || input.remainingAmount === '' ? 0 : input.remainingAmount);
  if (!Number.isFinite(finalAmount) || finalAmount < 0 || !Number.isFinite(total) || !Number.isFinite(remain) || total < finalAmount || remain < 0 || Math.abs(paid - finalAmount) > 0.01 || Math.abs(total - finalAmount - remain) > 0.01) return '结算金额不正确';
  return '';
}

async function currentUser() {
  const openid = String(cloud.getWXContext().OPENID || '').trim();
  if (!openid) return null;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const testRes = await db.collection('users').where({
    isTest: true,
    testSessionOpenid: openid,
    testSessionTime: _.gt(cutoff)
  }).limit(1).get();
  if (testRes.data && testRes.data[0]) return testRes.data[0];

  const bindingId = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 40);
  const bindingResult = await db.collection('openid_bindings').doc(bindingId).get().catch(() => ({ data: null }));
  if (bindingResult.data && bindingResult.data.userId) {
    const boundUser = await db.collection('users').doc(String(bindingResult.data.userId)).get().catch(() => ({ data: null }));
    if (boundUser.data && String(boundUser.data.openid || '') === openid) return boundUser.data;
    // 绑定登记与员工表不一致时 fail-closed，不根据姓名或手机号猜身份。
    return null;
  }

  // 兼容上线前的旧绑定数据：必须且只能找到一条正式员工记录，再补写绑定登记。
  const res = await db.collection('users').where({ openid }).limit(2).get();
  const users = res.data || [];
  if (users.length !== 1) {
    if (users.length > 1) console.error('检测到同一 OpenID 绑定多个员工，请管理员处理：', bindingId);
    return null;
  }
  const user = users[0];
  await db.collection('openid_bindings').doc(bindingId).set({ data: {
    userId: user._id,
    createdAt: new Date().toISOString(),
    migratedFromUsers: true
  } }).catch(error => console.warn('补写 OpenID 绑定登记失败：', error.message));
  return user;
}

const hasRole = (user, roles) => Boolean(user && roles.includes(user.role));
const isAssignedWorker = (user, order) => {
  if (!user || !order || user.role !== 'worker') return false;
  // 新数据一律使用不可变 users._id。只有历史订单尚未迁移 workerId 时才兼容手机号。
  if (order.workerId) return String(order.workerId) === String(user._id);
  return Boolean(user.phone && order.workerPhone === user.phone);
};
const canSettle = (user, order) => Boolean(
  user && order && (hasRole(user, ['leader']) || isAssignedWorker(user, order))
);
const canAccess = (user, order) => {
  if (!user || !order) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'worker') return isAssignedWorker(user, order);
  const cities = normalizedCities(user.cities);
  return Boolean(order.city && cities.includes(order.city));
};

const normalizedCities = value => {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim());
  if (value && typeof value === 'object') return Object.values(value).filter(item => typeof item === 'string' && item.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
};

function canServeCity(worker, city) {
  const cities = normalizedCities(worker && worker.cities);
  return Boolean(city && cities.length > 0 && cities.includes(city));
}

async function findAssignableWorker(input) {
  const source = input && typeof input === 'object' ? input : { workerPhone: input };
  const workerId = String(source.workerId || '').trim();
  let worker = null;
  if (workerId) {
    try {
      const result = await db.collection('users').doc(workerId).get();
      worker = result.data || null;
    } catch (error) {
      worker = null;
    }
  } else {
    const workerPhone = String(source.workerPhone || source.phone || '').trim();
    if (!/^1\d{10}$/.test(workerPhone)) return { error: '派单师傅信息无效' };
    const result = await db.collection('users').where({ phone: workerPhone }).limit(1).get();
    worker = result.data && result.data[0];
  }
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
    const matchesRequested = !requestedCity || (workerCities.length > 0 && workerCities.includes(requestedCity));
    const matchesLeaderScope = user.role === 'admin' || (allowedCities.length > 0 && workerCities.length > 0 && workerCities.some(value => allowedCities.includes(value)));
    return matchesRequested && matchesLeaderScope;
  }).map(clientWorker);
}


const UPLOAD_RETENTION_MS = 72 * 60 * 60 * 1000;

function uploadRegistryId(fileID) {
  return crypto.createHash('sha256').update(String(fileID || '')).digest('hex').slice(0, 32);
}

function orderReferencesFile(order, fileID) {
  if (!order || !fileID) return false;
  if (Array.isArray(order.finishPhotos) && order.finishPhotos.includes(fileID)) return true;
  if (Array.isArray(order.feedbacks) && order.feedbacks.some(item => {
    const photos = item && (item.photos || item.images);
    return Array.isArray(photos) && photos.includes(fileID);
  })) return true;
  if (Array.isArray(order.paymentLogs) && order.paymentLogs.some(item => Array.isArray(item && item.photos) && item.photos.includes(fileID))) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uploadPathMatches(fileID, orderId, operationId, kind) {
  const segment = kind === 'payment' ? 'payments' : 'feedback';
  const pattern = new RegExp(`/orders/${escapeRegExp(orderId)}/${segment}/${escapeRegExp(operationId)}/[^/]+$`);
  return pattern.test(String(fileID || ''));
}

async function trackUploadedFiles(user, input) {
  const data = input && typeof input === 'object' ? input : {};
  const orderId = String(data.orderId || '').trim();
  const operationId = String(data.operationId || '').trim();
  const kind = String(data.kind || '').trim();
  const fileIDs = Array.isArray(data.fileIDs) ? [...new Set(data.fileIDs.map(v => String(v || '').trim()).filter(Boolean))] : [];
  if (!orderId || !operationId || !['payment', 'feedback'].includes(kind) || !fileIDs.length || fileIDs.length > 9) {
    return { success: false, msg: '上传文件登记参数无效' };
  }
  const orderResult = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }));
  if (!orderResult.data || !canAccess(user, orderResult.data)) return { success: false, msg: '无权登记该工单文件' };
  if (!fileIDs.every(fileID => uploadPathMatches(fileID, orderId, operationId, kind))) {
    return { success: false, code: 'UPLOAD_PATH_MISMATCH', msg: '上传文件路径与当前工单操作不匹配' };
  }
  const now = new Date();
  const uploadedAt = now.toISOString();
  const cleanupAfter = new Date(now.getTime() + UPLOAD_RETENTION_MS).toISOString();
  await Promise.all(fileIDs.map(fileID => db.collection('upload_registry').doc(uploadRegistryId(fileID)).set({ data: {
    fileID, orderId, operationId, kind, uploaderId: user._id, uploadedAt, cleanupAfter, status: 'PENDING'
  } })));
  return { success: true, tracked: fileIDs.length, cleanupAfter };
}

async function removeUploadRegistryRecords(user, input, requireReference = false) {
  const data = input && typeof input === 'object' ? input : {};
  const fileIDs = Array.isArray(data.fileIDs) ? [...new Set(data.fileIDs.map(v => String(v || '').trim()).filter(Boolean))] : [];
  if (!fileIDs.length || fileIDs.length > 9) return { success: false, msg: '文件列表无效' };
  let removed = 0;
  for (const fileID of fileIDs) {
    const refId = uploadRegistryId(fileID);
    const recordResult = await db.collection('upload_registry').doc(refId).get().catch(() => ({ data: null }));
    const record = recordResult.data;
    if (!record) continue;
    if (record.uploaderId !== user._id && user.role !== 'admin') {
      const orderResult = await db.collection('orders').doc(record.orderId).get().catch(() => ({ data: null }));
      if (!orderResult.data || !canAccess(user, orderResult.data)) continue;
    }
    if (requireReference) {
      const orderResult = await db.collection('orders').doc(record.orderId).get().catch(() => ({ data: null }));
      if (!orderReferencesFile(orderResult.data, fileID)) continue;
    }
    await db.collection('upload_registry').doc(refId).remove().catch(() => null);
    removed += 1;
  }
  return { success: true, removed };
}

async function validateTrackedOperationFiles(user, orderId, operationId, kind, fileIDs) {
  const ids = normalizePhotos(fileIDs, 9);
  if (!ids.length) return { success: true, fileIDs: [] };
  if (!orderId || !operationId || !['payment', 'feedback'].includes(kind)) {
    return { success: false, code: 'UPLOAD_REFERENCE_INVALID', msg: '上传文件引用参数无效' };
  }
  for (const fileID of ids) {
    if (!uploadPathMatches(fileID, orderId, operationId, kind)) {
      return { success: false, code: 'UPLOAD_PATH_MISMATCH', msg: '上传文件路径与当前工单操作不匹配' };
    }
    const recordResult = await db.collection('upload_registry').doc(uploadRegistryId(fileID)).get().catch(() => ({ data: null }));
    const record = recordResult.data;
    if (!record || record.status !== 'PENDING' || String(record.fileID || '') !== fileID ||
        String(record.orderId || '') !== String(orderId) || String(record.operationId || '') !== String(operationId) ||
        String(record.kind || '') !== kind || String(record.uploaderId || '') !== String(user._id || '')) {
      return { success: false, code: 'UPLOAD_REFERENCE_INVALID', msg: '上传文件登记无效或已失效，请重新选择照片' };
    }
  }
  return { success: true, fileIDs: ids };
}

async function listAccessibleOrders(user) {
  if (!user) return [];
  if (user.role === 'admin') return await listCollection('orders');
  if (user.role === 'worker') {
    const result = [];
    const seen = new Set();
    const byId = await queryAllBy('orders', { workerId: user._id }).catch(() => []);
    for (const order of byId) {
      if (!seen.has(order._id)) { seen.add(order._id); result.push(order); }
    }
    // 仅用于兼容尚未迁移 workerId 的历史订单。
    if (user.phone) {
      const byPhone = await queryAllBy('orders', { workerPhone: user.phone }).catch(() => []);
      for (const order of byPhone) {
        if (order.workerId) continue;
        if (!seen.has(order._id)) { seen.add(order._id); result.push(order); }
      }
    }
    return result;
  }
  const cities = normalizedCities(user.cities);
  if (!cities.length) return [];
  return await queryAllBy('orders', { city: _.in(cities) });
}

async function getReferenceCities() {
  const items = await queryAllBy('cities', { enabled: true }).catch(() => []);
  items.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
  return items.map(item => ({ _id: item._id, name: String(item.name || '').trim(), sort: Number(item.sort || 0) })).filter(item => item.name);
}

async function getReferenceSources() {
  // 渠道配置量很小；兼容历史数据没有 enabled 字段的情况，仅显式 enabled=false 时隐藏。
  const items = (await listCollection('order_sources').catch(() => [])).filter(item => item.enabled !== false);
  items.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
  return items.map(item => ({ _id: item._id, name: String(item.name || '').trim(), sort: Number(item.sort || 0), enabled: item.enabled !== false })).filter(item => item.name);
}

async function isConfiguredSource(name) {
  const source = String(name || '').trim();
  if (!source) return false;
  const found = await db.collection('order_sources').where({ name: source }).limit(5).get().catch(() => ({ data: [] }));
  if ((found.data || []).some(item => item.enabled !== false)) return true;
  // 首次部署若渠道集合尚未初始化，保留最小默认集以避免录单完全不可用。
  const count = await db.collection('order_sources').count().catch(() => ({ total: 0 }));
  return Number(count.total || 0) === 0 && ['抖音', '美团', '转介绍', '其他'].includes(source);
}

async function getOrdersByIds(ids) {
  const unique = [...new Set((ids || []).map(v => String(v || '').trim()).filter(Boolean))];
  if (!unique.length) return [];
  const out = [];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const res = await db.collection('orders').where({ _id: _.in(batch) }).get().catch(() => ({ data: [] }));
    out.push(...(res.data || []));
  }
  return out;
}

async function queryAllBy(name, query) {
  const items = [];
  for (let skip = 0; ; skip += 100) {
    const result = await db.collection(name).where(query).skip(skip).limit(100).get();
    items.push(...(result.data || []));
    if (!result.data || result.data.length < 100) break;
  }
  return items;
}

async function backfillWorkerIdentity(userId, oldPhone, newPhone, newName) {
  if (!oldPhone) return;
  const legacyOrders = await queryAllBy('orders', { workerPhone: oldPhone }).catch(() => []);
  for (const order of legacyOrders) {
    if (order.workerId && String(order.workerId) !== String(userId)) continue;
    await db.collection('orders').doc(order._id).update({ data: {
      workerId: userId,
      ...(newPhone ? { workerPhone: newPhone } : {}),
      ...(newName ? { workerName: newName } : {})
    } });
  }
  const legacyPayments = await queryAllBy('payment_transactions', { workerPhone: oldPhone }).catch(() => []);
  for (const tx of legacyPayments) {
    if (tx.workerId && String(tx.workerId) !== String(userId)) continue;
    await db.collection('payment_transactions').doc(tx._id).update({ data: { workerId: userId } });
  }
}

async function getPaymentStats(user, input) {
  if (!hasRole(user, ['admin', 'leader'])) return { success: false, msg: '仅管理员或主管可查看营收统计' };
  const data = input && typeof input === 'object' ? input : {};
  const startAt = String(data.startAt || '').trim();
  const endAt = String(data.endAt || '').trim();
  const startMs = startAt ? Date.parse(startAt) : NaN;
  const endMs = endAt ? Date.parse(endAt) : NaN;
  if ((startAt && !Number.isFinite(startMs)) || (endAt && !Number.isFinite(endMs)) || (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > endMs)) {
    return { success: false, msg: '统计时间范围无效' };
  }

  const requestedCity = String(data.city || 'all').trim() || 'all';
  const workerId = String(data.workerId || '').trim();
  const workerPhone = String(data.workerPhone || '').trim();
  let legacyWorkerPhone = workerPhone;
  if (workerId) {
    const target = await db.collection('users').doc(workerId).get().catch(() => ({ data: null }));
    if (target.data && target.data.phone) legacyWorkerPhone = String(target.data.phone);
  }
  const allowedCities = normalizedCities(user.cities);
  if (user.role === 'leader') {
    if (!allowedCities.length) return { success: true, totalRevenue: 0, cashRevenue: 0, wechatRevenue: 0, alipayRevenue: 0, transactionCount: 0, correctionCount: 0, byWorker: {} };
    if (requestedCity !== 'all' && !allowedCities.includes(requestedCity)) return { success: false, msg: '无权查看该城市统计' };
  }

  // 先在数据库层按时间范围裁剪支付流水，避免每次统计扫描整个 payment_transactions。
  const timeQuery = {};
  if (startAt && endAt) timeQuery.createdAt = _.gte(startAt).and(_.lte(endAt));
  else if (startAt) timeQuery.createdAt = _.gte(startAt);
  else if (endAt) timeQuery.createdAt = _.lte(endAt);
  const transactions = Object.keys(timeQuery).length
    ? await queryAllBy('payment_transactions', timeQuery)
    : await listCollection('payment_transactions');

  // 只有历史流水缺少 city / workerId 等快照时才回查对应订单，不再全表读取 orders。
  const fallbackOrderIds = transactions.filter(tx => !tx.city || !tx.workerId).map(tx => tx.orderId);
  const fallbackOrders = await getOrdersByIds(fallbackOrderIds);
  const orderMap = new Map(fallbackOrders.map(item => [item._id, item]));

  const money = value => Number(Number(value || 0).toFixed(2));
  const byWorker = {};
  let totalRevenue = 0;
  let cashRevenue = 0;
  let wechatRevenue = 0;
  let alipayRevenue = 0;
  let transactionCount = 0;
  let correctionCount = 0;

  const addToBucket = (bucket, totalDelta, cashDelta, wechatDelta, alipayDelta, isCorrection) => {
    bucket.totalRevenue = money((bucket.totalRevenue || 0) + totalDelta);
    bucket.cashRevenue = money((bucket.cashRevenue || 0) + cashDelta);
    bucket.wechatRevenue = money((bucket.wechatRevenue || 0) + wechatDelta);
    bucket.alipayRevenue = money((bucket.alipayRevenue || 0) + alipayDelta);
    bucket.transactionCount = Number(bucket.transactionCount || 0) + (isCorrection ? 0 : 1);
    bucket.correctionCount = Number(bucket.correctionCount || 0) + (isCorrection ? 1 : 0);
  };

  for (const tx of transactions || []) {
    const createdMs = Date.parse(tx.createdAt || '');
    if (!Number.isFinite(createdMs)) continue;
    if (Number.isFinite(startMs) && createdMs < startMs) continue;
    if (Number.isFinite(endMs) && createdMs > endMs) continue;

    const fallbackOrder = orderMap.get(tx.orderId) || {};
    const txCity = String(tx.city || fallbackOrder.city || '').trim();
    const txWorkerId = String(tx.workerId || fallbackOrder.workerId || '').trim();
    const txWorkerPhone = String(tx.workerPhone || fallbackOrder.workerPhone || '').trim();
    const txWorkerName = String(tx.workerName || fallbackOrder.workerName || '').trim();
    if (user.role === 'leader' && (!txCity || !allowedCities.includes(txCity))) continue;
    if (requestedCity !== 'all' && txCity !== requestedCity) continue;

    const cashDelta = Number(tx.cashAfter || 0) - Number(tx.cashBefore || 0);
    const wechatDelta = Number(tx.wechatAfter || 0) - Number(tx.wechatBefore || 0);
    const alipayDelta = Number(tx.alipayAfter || 0) - Number(tx.alipayBefore || 0);
    if (![cashDelta, wechatDelta, alipayDelta].every(Number.isFinite)) continue;
    const isCorrection = tx.operationType === 'amount_correction';
    let totalDelta;
    if (isCorrection) {
      const paidBefore = Number(tx.paidBefore || 0);
      const paidAfter = Number(tx.paidAfter || 0);
      if (!Number.isFinite(paidBefore) || !Number.isFinite(paidAfter)) continue;
      totalDelta = paidAfter - paidBefore;
    } else {
      totalDelta = Number(tx.amountThisTime || 0);
      if (!Number.isFinite(totalDelta)) continue;
    }

    // 一次请求同时返回师傅维度聚合，消除前端按每个师傅再次调用 getPaymentStats 的 N+1 请求。
    const workerKey = txWorkerId ? `id:${txWorkerId}` : (txWorkerPhone ? `legacy-phone:${txWorkerPhone}` : 'unassigned');
    if (!byWorker[workerKey]) {
      byWorker[workerKey] = { workerId: txWorkerId, workerPhone: txWorkerPhone, workerName: txWorkerName, totalRevenue: 0, cashRevenue: 0, wechatRevenue: 0, alipayRevenue: 0, transactionCount: 0, correctionCount: 0 };
    }
    addToBucket(byWorker[workerKey], totalDelta, cashDelta, wechatDelta, alipayDelta, isCorrection);

    const matchesRequestedWorker = workerId
      ? (txWorkerId ? txWorkerId === workerId : Boolean(legacyWorkerPhone && txWorkerPhone === legacyWorkerPhone))
      : (workerPhone ? txWorkerPhone === workerPhone : true);
    if (!matchesRequestedWorker) continue;

    totalRevenue += totalDelta;
    cashRevenue += cashDelta;
    wechatRevenue += wechatDelta;
    alipayRevenue += alipayDelta;
    if (isCorrection) correctionCount += 1;
    else transactionCount += 1;
  }

  return {
    success: true,
    totalRevenue: money(totalRevenue),
    cashRevenue: money(cashRevenue),
    wechatRevenue: money(wechatRevenue),
    alipayRevenue: money(alipayRevenue),
    transactionCount,
    correctionCount,
    byWorker
  };
}

exports.main = async (event = {}) => {
  // TriggerName 是普通事件字段，客户端可以伪造；系统任务必须同时没有用户 OpenID。
  const triggerContext = cloud.getWXContext();
  const triggerName = String(event.TriggerName || '');
  const systemTrigger = Boolean(triggerName && !triggerContext.OPENID);
  const triggerActions = {
    notificationRetryEveryMinute: 'retryNotificationEvents'
  };
  const action = event.action || (systemTrigger ? (triggerActions[triggerName] || '') : '');
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
    const rawBuildNo = Number(event.buildNo);
    const rawApiSchema = Number(event.apiSchema);
    const buildNo = Number.isFinite(rawBuildNo) ? rawBuildNo : 0;
    const apiSchema = Number.isFinite(rawApiSchema) ? rawApiSchema : 0;
    let policy = DEFAULT_CLIENT_POLICY;
    try {
      const result = await db.collection('system_config').doc('clientPolicy').get();
      if (result.data && typeof result.data === 'object') policy = { ...DEFAULT_CLIENT_POLICY, ...result.data };
    } catch (error) { console.warn('读取客户端版本策略失败，使用默认策略：', error.message); }
    if (systemTrigger && action !== 'retryNotificationEvents') return { success: false, code: 'SYSTEM_ACTION_DENIED', msg: '系统任务操作无效' };
    if (!systemTrigger) {
      const requiredSchema = Number(policy.apiSchema || 0);
      const minReadBuild = Number(policy.minReadBuild || 0);
      const minWriteBuild = Number(policy.minWriteBuild || 0);
      if (requiredSchema > 0 && apiSchema < requiredSchema) return { success: false, code: 'CLIENT_UPDATE_REQUIRED', policy, msg: policy.message };
      if (minReadBuild > 0 && buildNo < minReadBuild) return { success: false, code: 'CLIENT_UPDATE_REQUIRED', policy, msg: policy.message };
      if (WRITE_ACTIONS.has(action) && minWriteBuild > 0 && buildNo < minWriteBuild) return { success: false, code: 'CLIENT_UPDATE_REQUIRED', policy, msg: policy.message };
    }
    // 城市/渠道属于登录页和录单页所需的只读基础数据，可在身份确认前读取；写操作仍全部要求登录。
    if (!systemTrigger && action === 'getCities') return { success: true, cities: await getReferenceCities() };
    if (!systemTrigger && action === 'getSources') return { success: true, sources: await getReferenceSources() };

    const user = systemTrigger ? { _id: 'system', role: 'admin', isTest: false, name: '系统重试任务' } : await currentUser();
    if (!user) return { success: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新登录' };

    if (action === 'getNotificationConfig') {
      return { success: true, templates: getNotificationConfig(user) };
    }

    if (action === 'getSessionUser') return { success: true, user: clientUser(user) };

    if (action === 'getOrders') {
      const orders = await listAccessibleOrders(user);
      return { success: true, orders };
    }

    if (action === 'getPaymentOperationStatus') {
      const targetOrderId = String(orderId || (data && data.orderId) || '').trim();
      const operationId = String(data && data.operationId || '').trim();
      if (!targetOrderId || !operationId) return { success: false, msg: '支付核对参数无效' };
      const orderResult = await db.collection('orders').doc(targetOrderId).get().catch(() => ({ data: null }));
      if (!orderResult.data || !canAccess(user, orderResult.data)) return { success: false, msg: '无权核对该工单支付状态' };
      const tx = await db.collection('payment_transactions').where({ orderId: targetOrderId, operationId }).limit(1).get().catch(() => ({ data: [] }));
      const item = tx.data && tx.data[0];
      return { success: true, committed: Boolean(item), paymentId: item ? item.paymentId : '', createdAt: item ? item.createdAt : '' };
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

    if (action === 'getPaymentStats') {
      return await getPaymentStats(user, data);
    }

    if (action === 'trackUploadedFiles') return await trackUploadedFiles(user, data);
    if (action === 'confirmUploadedFiles') return await removeUploadRegistryRecords(user, data, true);
    if (action === 'untrackUploadedFiles') return await removeUploadRegistryRecords(user, data, false);
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
      const result = await db.collection('notification_events').where({ status: _.in(['PENDING', 'FAILED', 'PARTIAL']), nextRetryAt: _.lte(now) }).limit(20).get();
      const typeMap = { NEW_ORDER: 'newOrder', FULL_PAYMENT: 'deal', DEPOSIT_PAYMENT: 'deal', ADDITIONAL_PAYMENT: 'deal', FINAL_PAYMENT: 'deal', AMOUNT_CORRECTION: 'deal', ONSITE_FAILED: 'unconverted', SERVICE_CANCELLED: 'unconverted' };
      const output = [];
      for (const event of (result.data || [])) {
        const attempts = Number(event.retryCount || 0);
        // retryCount=1 表示初次发送已失败；允许 attempts=1/2/3 分别执行第1/2/3次真实重试。
        if (attempts > 3) { await db.collection('notification_events').doc(event._id).update({ data: { status: 'RETRY_EXHAUSTED', errorCode: 'RETRY_EXHAUSTED', nextRetryAt: '', updatedAt: now } }); output.push({ eventId: event.eventId, status: 'RETRY_EXHAUSTED' }); continue; }
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
        const retryable = notification.retryable === true;
        const isThirdRetry = attempts >= 3;
        const delay = attempts === 0 ? 60000 : (attempts === 1 ? 300000 : 1800000); // PENDING补发失败后等1分钟；第1次重试失败后等5分钟；第2次重试失败后等30分钟。
        const nextStatus = retryable && isThirdRetry ? 'RETRY_EXHAUSTED' : (notification.status || 'FAILED');
        await db.collection('notification_events').doc(event._id).update({ data: {
          retryCount: attempts + 1,
          status: nextStatus,
          errorCode: retryable && isThirdRetry ? 'RETRY_EXHAUSTED' : '',
          nextRetryAt: retryable && !isThirdRetry ? new Date(Date.now() + delay).toISOString() : '',
          updatedAt: new Date().toISOString()
        } });
        output.push({ eventId: event.eventId, status: nextStatus });
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
      if (!/^1\d{10}$/.test(phone)) return { success: false, msg: '请输入正确的11位手机号' };
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
      const createOperationId = String(data && data.createOperationId || '').trim();
      if (!/^create_[A-Za-z0-9_-]{8,80}$/.test(createOperationId)) return { success: false, code: 'CREATE_OPERATION_ID_REQUIRED', msg: '录单请求标识无效，请重新提交' };
      const existingOperation = await getCreateOperation(createOperationId);
      if (existingOperation) {
        if (String(existingOperation.creatorId || '') !== String(user._id)) {
          return { success: false, code: 'CREATE_OPERATION_ID_CONFLICT', msg: '录单请求标识冲突，请重新进入录单页面' };
        }
        return {
          success: true,
          duplicate: true,
          orderId: existingOperation.orderId,
          eventId: 'evt_' + existingOperation.orderId,
          notification: { success: true, status: 'ALREADY_CREATED' }
        };
      }
      // 兼容升级前已创建、但尚无 order_operations 登记的订单。
      const legacyDuplicate = await db.collection('orders').where({ createOperationId }).limit(1).get();
      if (legacyDuplicate.data && legacyDuplicate.data[0]) {
        const existing = legacyDuplicate.data[0];
        if (existing.creatorId && String(existing.creatorId) !== String(user._id)) {
          return { success: false, code: 'CREATE_OPERATION_ID_CONFLICT', msg: '录单请求标识冲突，请重新进入录单页面' };
        }
        await db.collection('order_operations').doc(createOperationDocId(createOperationId)).set({ data: {
          createOperationId,
          orderId: existing._id,
          creatorId: existing.creatorId || user._id,
          createdAt: existing.createTime || new Date().toISOString()
        } }).catch(() => null);
        return { success: true, duplicate: true, orderId: existing._id, eventId: 'evt_' + existing._id, notification: { success: true, status: 'ALREADY_CREATED' } };
      }
      const wantsAssignment = Boolean(data && (data.workerId || data.workerName || data.workerPhone));
      if (user.role !== 'leader' && wantsAssignment) return { success: false, msg: '客服录单后请由主管派单' };
      const createFields = ['city', 'customerPhone', 'address', 'appointmentTime', 'source', 'totalAmount', 'paidAmount', 'pendingBalance'];
      if (user.role === 'leader') createFields.push(...fields.assign);
      const payload = pick(data, createFields);
      // 首条录单回馈只接受正文；时间、操作人和角色全部由服务端生成，避免客户端伪造审计字段。
      const initialFeedbackRaw = String(data && data.initialFeedback || (Array.isArray(data && data.feedbacks) && data.feedbacks[0] && data.feedbacks[0].content) || '').trim();
      if (initialFeedbackRaw) {
        const content = initialFeedbackRaw.startsWith('【录单回馈】') ? initialFeedbackRaw : `【录单回馈】${initialFeedbackRaw}`;
        payload.feedbacks = [{
          id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          time: new Date().toISOString(),
          operatorName: user.name || '客服',
          operatorRole: user.role || 'service',
          content: content.slice(0, 2000),
          photos: []
        }];
      } else {
        payload.feedbacks = [];
      }
      const cities = normalizedCities(user.cities);
      if (!payload.city || !cities.includes(payload.city)) return { success: false, msg: '无权录入该城市工单' };
      if (!await isConfiguredSource(payload.source)) return { success: false, msg: '订单来源无效或已停用，请刷新渠道列表后重试' };
      if (user.role === 'leader' && wantsAssignment) {
        const assigned = await findAssignableWorker({ workerId: data && data.workerId, workerPhone: payload.workerPhone });
        if (assigned.error) return { success: false, msg: assigned.error };
        if (!canServeCity(assigned.worker, payload.city)) return { success: false, msg: '该师傅不负责此城市，不能派单' };
        // 姓名仅作展示，必须以后端手机号查到的员工资料为准。
        payload.workerId = assigned.worker._id;
        payload.workerName = assigned.worker.name || '';
        payload.workerPhone = assigned.worker.phone;
      }
      Object.assign(payload, { createOperationId, creatorId: user._id, creatorName: user.name, creatorPhone: user.phone || '', createTime: new Date().toISOString(), status: payload.workerId ? '已派单' : '待派单', version: 1 });
      const createdAt = new Date().toISOString();
      const result = await createOrderEventTransaction(createOperationId, payload, { eventType: 'NEW_ORDER', groupType: 'order_entry', city: payload.city, operationId: '', actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', nextRetryAt: new Date(Date.now() + 60000).toISOString(), createdAt, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }, user);
      const eventId = 'evt_' + result._id;
      if (result.duplicate) {
        return { success: true, duplicate: true, orderId: result._id, eventId, notification: { success: true, status: 'ALREADY_CREATED' } };
      }
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

      const requested = new Set(orderIds.map(id => String(id || '').trim()).filter(Boolean));
      if (requested.size !== orderIds.length) return { success: false, msg: '工单列表包含重复或无效ID' };

      // 批量派单也必须使用每单的 expectedVersion，不能只做 version + 1。
      const rawVersions = data && data.orderVersions;
      if (!rawVersions || typeof rawVersions !== 'object' || Array.isArray(rawVersions)) {
        return { success: false, code: 'BATCH_VERSION_REQUIRED', msg: '批量派单缺少订单版本，请刷新列表后重试' };
      }
      const versionMap = new Map();
      for (const id of requested) {
        const version = Number(rawVersions[id]);
        if (!Number.isInteger(version) || version < 0) {
          return { success: false, code: 'INVALID_ORDER_VERSION', msg: '批量派单包含无效订单版本，请刷新列表后重试' };
        }
        versionMap.set(id, version);
      }

      const targetOrders = await db.collection('orders').where({ _id: _.in([...requested]) }).get();
      const found = (targetOrders.data || []).filter(order => requested.has(order._id));
      if (found.length !== requested.size || found.some(order => !canAccess(user, order))) {
        return { success: false, msg: '含有不存在或无权操作的工单' };
      }

      const assigned = await findAssignableWorker(data);
      if (assigned.error) return { success: false, msg: assigned.error };
      if (found.some(order => !canServeCity(assigned.worker, order.city))) {
        return { success: false, msg: '该师傅不负责其中部分工单所在城市，不能批量派单' };
      }

      let updated = 0;
      const skippedOrders = [];
      for (const id of requested) {
        try {
          await commitOrderMutation(id, {
            expectedVersion: versionMap.get(id),
            user,
            mutate: current => {
              if (ARCHIVED_STATUSES.includes(current.status)) throw makeOrderError('ORDER_ARCHIVED', '归档工单不可派单');
              if (!canServeCity(assigned.worker, current.city)) throw makeOrderError('ORDER_STATE_CHANGED', '该师傅不负责此城市，不能派单');
              return {
                patch: {
                  workerId: assigned.worker._id,
                  workerName: assigned.worker.name || '',
                  workerPhone: assigned.worker.phone,
                  status: '已派单',
                  assignTime: new Date().toISOString()
                }
              };
            }
          });
          updated += 1;
        } catch (error) {
          const response = mutationErrorResponse(error);
          if (response) {
            skippedOrders.push({ orderId: id, code: response.code || 'ORDER_CHANGED' });
            continue;
          }
          throw error;
        }
      }

      return {
        success: true,
        requested: requested.size,
        updated,
        skipped: skippedOrders.length,
        skippedOrders
      };
    }

    if (action === 'updateUser' || action === 'unbindUser') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理员工' };
      if (!userId) return { success: false, msg: '缺少员工ID' };
      if (action === 'unbindUser') {
        if (userId === user._id) return { success: false, msg: '不能解绑当前登录账号' };
        const targetResult = await db.collection('users').doc(userId).get().catch(() => ({ data: null }));
        const targetUser = targetResult.data;
        if (!targetUser) return { success: false, msg: '员工不存在' };
        const oldOpenid = String(targetUser.openid || '').trim();
        const transaction = await db.startTransaction();
        try {
          await transaction.collection('users').doc(userId).update({ data: { openid: '' } });
          if (oldOpenid) {
            const bindingId = crypto.createHash('sha256').update(oldOpenid).digest('hex').slice(0, 40);
            const binding = await transaction.collection('openid_bindings').doc(bindingId).get().catch(() => ({ data: null }));
            if (binding.data && String(binding.data.userId || '') === String(userId)) {
              await transaction.collection('openid_bindings').doc(bindingId).remove();
            }
          }
          await transaction.commit();
        } catch (error) {
          try { await transaction.rollback(); } catch (rollbackError) { /* ignore */ }
          throw error;
        }
      }
      else {
        const payload = pick(data, ['name', 'phone', 'role', 'cities', 'isTest']);
        if (payload.name !== undefined) {
          payload.name = String(payload.name || '').trim();
          if (!payload.name) return { success: false, msg: '员工姓名不能为空' };
        }
        if (payload.role && !['admin', 'leader', 'service', 'worker'].includes(payload.role)) return { success: false, msg: '角色无效' };
        if (payload.isTest !== undefined) payload.isTest = Boolean(payload.isTest);
        if (payload.phone !== undefined) {
          payload.phone = String(payload.phone).trim();
          if (!/^1\d{10}$/.test(payload.phone)) return { success: false, msg: '请输入正确的11位手机号' };
          const conflict = await db.collection('users').where({ phone: payload.phone }).limit(1).get();
          if (conflict.data && conflict.data.some(item => item._id !== userId)) return { success: false, msg: '该手机号已被其他员工使用' };
        }
        if (payload.cities !== undefined) payload.cities = normalizedCities(payload.cities);
        const targetResult = await db.collection('users').doc(userId).get();
        const targetUser = targetResult.data;
        if (!targetUser) return { success: false, msg: '员工不存在' };
        // 系统管理员身份不可通过普通员工编辑接口创建、降级或转移；必须保持数据库中的既有管理员身份。
        if (payload.role !== undefined) {
          if (targetUser.role === 'admin' && payload.role !== 'admin') return { success: false, msg: '系统管理员身份不可修改' };
          if (targetUser.role !== 'admin' && payload.role === 'admin') return { success: false, msg: '不能通过员工编辑接口提升为系统管理员' };
        }
        const nextRole = payload.role !== undefined ? payload.role : targetUser.role;
        const nextCities = payload.cities !== undefined ? payload.cities : normalizedCities(targetUser.cities);
        if (nextRole !== 'admin' && !nextCities.length) return { success: false, msg: '非管理员员工请至少分配一个城市' };
        if (payload.isTest === true && targetUser.isTest !== true && String(targetUser.openid || '').trim()) {
          return { success: false, msg: '已绑定微信的正式员工请先解绑，再改为测试账号' };
        }
        const oldPhone = String(targetUser.phone || '').trim();
        const nextPhone = payload.phone !== undefined ? payload.phone : oldPhone;
        const nextName = payload.name !== undefined ? String(payload.name || '').trim() : String(targetUser.name || '');
        // 手机号/姓名变更前先给历史订单和支付流水补不可变 workerId，防止换号后丢失历史工单权限。
        if (['worker', 'leader'].includes(targetUser.role) || ['worker', 'leader'].includes(nextRole)) {
          await backfillWorkerIdentity(userId, oldPhone, nextPhone, nextName);
        }
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
      const assigned = await findAssignableWorker(data);
      if (assigned.error) return { success: false, msg: assigned.error };
      const expectedVersion = readExpectedVersion(event, data);
      try {
        const mutation = await commitOrderMutation(orderId, {
          expectedVersion,
          user,
          mutate: current => {
            if (ARCHIVED_STATUSES.includes(current.status)) throw makeOrderError('ORDER_ARCHIVED', '归档工单不可改派');
            if (!canServeCity(assigned.worker, current.city)) throw makeOrderError('ORDER_STATE_CHANGED', '该师傅不负责此城市，不能派单');
            return { patch: { workerId: assigned.worker._id, workerName: assigned.worker.name || '', workerPhone: assigned.worker.phone, status: '已派单', assignTime: new Date().toISOString() } };
          }
        });
        return { success: true, version: mutation.after.version };
      } catch (error) {
        const response = mutationErrorResponse(error);
        if (response) return response;
        throw error;
      }
    } else if (action === 'urgent') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无催单权限' };
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - 60000).toISOString();
      const claim = await db.collection('orders').where(_.and([
        { _id: orderId, status: _.nin(['已完工', '未成单']) },
        _.or([{ urgentTime: _.exists(false) }, { urgentTime: '' }, { urgentTime: _.lt(cutoff) }])
      ])).update({ data: { isUrgent: true, urgentTime: now, version: _.inc(1) } });
      if (!claim.stats || claim.stats.updated !== 1) return { success: false, msg: '请勿重复催单，请稍后再试' };
      return { success: true, msg: '催单状态已更新' };
    } else if (action === 'editTime') {
      if (!hasRole(user, ['service', 'leader', 'worker'])) return { success: false, msg: '无改期权限' };
      const newTime = String(data && data.appointmentTime || '').trim();
      if (!newTime) return { success: false, msg: '请输入预约时间' };
      const expectedVersion = readExpectedVersion(event, data);
      try {
        const mutation = await commitOrderMutation(orderId, {
          expectedVersion,
          user,
          mutate: current => {
            if (ARCHIVED_STATUSES.includes(current.status)) throw makeOrderError('ORDER_ARCHIVED', '归档工单不可改期');
            if (newTime === String(current.appointmentTime || '')) return { patch: {} };
            const now = new Date().toISOString();
            const log = {
              id: `time_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              oldTime: current.appointmentTime || '',
              newTime,
              operatorName: user.name || '员工',
              operatorRole: user.role || 'service',
              time: now,
              timeFormatted: now
            };
            const feedback = {
              id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              time: now,
              timeFormatted: now,
              operatorName: user.name || '员工',
              operatorRole: user.role || 'service',
              content: `[预约改期] 预约时间由【${current.appointmentTime || ''}】更改为【${newTime}】`,
              photos: []
            };
            return {
              patch: {
                appointmentTime: newTime,
                appointmentLogs: [log, ...(Array.isArray(current.appointmentLogs) ? current.appointmentLogs : [])],
                feedbacks: [feedback, ...(Array.isArray(current.feedbacks) ? current.feedbacks : [])]
              }
            };
          }
        });
        return { success: true, version: mutation.after.version };
      } catch (error) {
        const response = mutationErrorResponse(error);
        if (response) return response;
        throw error;
      }
    } else if (action === 'cancelOrder') {
      // 客服退单只能由客服发起；状态校验、反馈追加和归档必须在同一事务中完成。
      if (!hasRole(user, ['service'])) return { success: false, msg: '仅客服可取消工单' };
      const reason = String(data && data.cancelReason || '').trim();
      if (!reason) return { success: false, msg: '请填写取消原因' };
      const expectedVersion = readExpectedVersion(event, data);
      const now = new Date().toISOString();
      const eventId = 'evt_' + orderId + '_service_cancel';
      let mutation;
      try {
        mutation = await commitOrderMutation(orderId, {
          expectedVersion,
          user,
          mutate: current => {
            if (ARCHIVED_STATUSES.includes(current.status)) throw makeOrderError('ORDER_ARCHIVED', '归档工单不可取消');
            const feedback = {
              id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              time: now,
              operatorName: user.name || '客服',
              operatorRole: 'service',
              content: `[客服退单取消] 理由：${reason}`,
              photos: []
            };
            return {
              patch: {
                status: '未成单',
                uncompletedType: 'service_cancel',
                cancelReason: reason,
                cancelOperator: user.name || '客服',
                cancelTime: now,
                feedbacks: [feedback, ...(Array.isArray(current.feedbacks) ? current.feedbacks : [])],
                isUrgent: false
              },
              eventData: { eventId, eventKey: `order:${orderId}:unconverted:service_cancel`, orderId, eventType: 'SERVICE_CANCELLED', groupType: 'unconverted', city: current.city, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', nextRetryAt: new Date(Date.now() + 60000).toISOString(), createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }
            };
          }
        });
      } catch (error) {
        const response = mutationErrorResponse(error);
        if (response) return response;
        throw error;
      }
      let notification;
      try {
        notification = await notifyConfiguredGroups(db, 'unconverted', { ...mutation.after, eventId }, user);
      } catch (notificationError) {
        console.error('退单已保存，但群通知处理失败：', notificationError.message);
        notification = { success: false, status: 'FAILED', code: 'NOTIFICATION_PROCESSING_FAILED', msg: '退单已保存，群通知待重试' };
      }
      return { success: true, version: mutation.after.version, notification };
    } else if (action === 'failOrder') {
      // 现场未成单：权限、最新状态、反馈追加和归档在同一事务中完成。
      if (!hasRole(user, ['leader', 'worker'])) return { success: false, msg: '仅负责该单的师傅或主管可标记未成单' };
      const reason = String(data && data.failReason || '').trim();
      if (!reason) return { success: false, msg: '请填写未成单原因' };
      const expectedVersion = readExpectedVersion(event, data);
      const now = new Date().toISOString();
      const eventId = 'evt_' + orderId + '_worker_fail';
      let mutation;
      try {
        mutation = await commitOrderMutation(orderId, {
          expectedVersion,
          user,
          mutate: current => {
            if (!canSettle(user, current)) throw makeOrderError('ORDER_ACCESS_DENIED', '仅负责该单的师傅或主管可标记未成单');
            if (ARCHIVED_STATUSES.includes(current.status)) throw makeOrderError('ORDER_ARCHIVED', '归档工单不可标记未成单');
            const operatorName = user.name || (user.role === 'leader' ? '主管' : '师傅');
            const feedback = {
              id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              time: now,
              operatorName,
              operatorRole: user.role === 'leader' ? 'leader' : 'worker',
              content: `[现场标记未成单] 理由：${reason}`,
              photos: []
            };
            return {
              patch: {
                status: '未成单',
                uncompletedType: 'worker_fail',
                failReason: reason,
                failOperator: operatorName,
                failTime: now,
                feedbacks: [feedback, ...(Array.isArray(current.feedbacks) ? current.feedbacks : [])],
                isUrgent: false
              },
              eventData: { eventId, eventKey: `order:${orderId}:unconverted:worker_fail`, orderId, eventType: 'ONSITE_FAILED', groupType: 'unconverted', city: current.city, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, status: 'PENDING', nextRetryAt: new Date(Date.now() + 60000).toISOString(), createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }
            };
          }
        });
      } catch (error) {
        const response = mutationErrorResponse(error);
        if (response) return response;
        throw error;
      }
      let notification;
      try {
        notification = await notifyConfiguredGroups(db, 'unconverted', { ...mutation.after, eventId }, user);
      } catch (notificationError) {
        console.error('未成单已保存，但群通知处理失败：', notificationError.message);
        notification = { success: false, status: 'FAILED', code: 'NOTIFICATION_PROCESSING_FAILED', msg: '未成单已保存，群通知待重试' };
      }
      return { success: true, version: mutation.after.version, notification };
    } else if (action === 'finishOrder') {
      if (!canSettle(user, order)) return { success: false, msg: '无结算权限' };
      if (order.status === '未成单') return { success: false, msg: '未成单不可结算' };
      const requestedOperationType = String(data.operationType || '').trim();
      const validationError = validateSettlement(data, { allowZeroPaid: requestedOperationType === 'amount_correction' });
      if (validationError) return { success: false, msg: validationError };
      const operationId = String(data.operationId || '').trim();
      if (!operationId) return { success: false, msg: '缺少操作流水号，请重试' };
      const duplicate = await db.collection('payment_transactions').where({ orderId, operationId }).limit(1).get().catch(() => ({ data: [] }));
      if (duplicate.data && duplicate.data[0]) return { success: true, duplicate: true, paymentId: duplicate.data[0].paymentId, msg: '订单已保存，未重复入账' };
      const clientPhotos = normalizePhotos(data && data.finishPhotos, 9);
      const existingPhotoSet = new Set(Array.isArray(order.finishPhotos) ? order.finishPhotos : []);
      const submittedNewPhotos = normalizePhotos(data && data.newFinishPhotos, 9);
      const candidateNewPhotos = submittedNewPhotos.length ? submittedNewPhotos : clientPhotos.filter(fileID => !existingPhotoSet.has(fileID));
      const photoValidation = await validateTrackedOperationFiles(user, orderId, operationId, 'payment', candidateNewPhotos);
      if (!photoValidation.success) return photoValidation;
      const beforePaid = Number(order.finalAmount || order.depositAmount || 0);
      const after = pick(data, fields.finish);
      // 客户端只负责提交本次新增照片；累计照片由服务端基于最新订单合并。
      after.finishPhotos = [...photoValidation.fileIDs, ...(Array.isArray(order.finishPhotos) ? order.finishPhotos : [])];
      const afterPaid = Number(after.finalAmount || after.depositAmount || 0);
      const operationType = requestedOperationType;
      const channelPaid = ['cashAmount', 'wechatAmount', 'alipayAmount'].reduce((sum, key) => sum + Number(after[key] || 0), 0);
      if (Math.abs(channelPaid - afterPaid) > 0.01) return { success: false, msg: '累计实收必须等于现金、微信和支付宝金额之和' };
      const channelsChanged = Number(order.cashAmount || 0) !== Number(after.cashAmount || 0) || Number(order.wechatAmount || 0) !== Number(after.wechatAmount || 0) || Number(order.alipayAmount || 0) !== Number(after.alipayAmount || 0);
      const amountChanged = beforePaid !== afterPaid || channelsChanged || Number(order.totalAmount || 0) !== Number(after.totalAmount || 0) || Number(order.remainingAmount || 0) !== Number(after.remainingAmount || 0);
      if (!amountChanged) {
        // 金额未变化时也进入版本事务：只能补充业务凭据，不能覆盖状态或历史支付流水。
        const clientExpectedVersion = readExpectedVersion(event, data);
        const expectedVersion = clientExpectedVersion === null ? Number(order.version || 0) : clientExpectedVersion;
        try {
          const mutation = await commitOrderMutation(orderId, {
            expectedVersion,
            user,
            mutate: current => {
              if (!canSettle(user, current)) throw makeOrderError('ORDER_ACCESS_DENIED', '无结算权限');
              if (current.status === '未成单') throw makeOrderError('ORDER_ARCHIVED', '未成单不可更新结算凭据');
              return { patch: {
                ...pick(data, ['companionWorkers', 'finishNote']),
                finishPhotos: [...photoValidation.fileIDs, ...(Array.isArray(current.finishPhotos) ? current.finishPhotos : [])]
              } };
            }
          });
          return { success: true, version: mutation.after.version, notification: { success: true, status: 'SUPPRESSED', msg: '仅更新照片或备注，未产生支付通知' } };
        } catch (error) {
          const response = mutationErrorResponse(error);
          if (response) return response;
          throw error;
        }
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
      // 订单状态与完工时间完全由服务端生成。金额修正若仍保持已完工，必须保留原 finishTime。
      const willBeCompleted = Number(after.remainingAmount || 0) === 0;
      after.status = willBeCompleted ? '已完工' : '已派单';
      if (willBeCompleted) {
        after.finishTime = order.status === '已完工' ? String(order.finishTime || '') : now;
      } else {
        // 若金额修正后重新产生待收款，则清除旧完工时间；再次结清时会生成新的完工时间。
        after.finishTime = '';
      }
      const operationPhotos = photoValidation.fileIDs;
      after.paymentLogs = [{
        id: paymentId, time: now, operatorName: user.name || '', operatorRole: user.role,
        operationType, settleType: after.settleType,
        currentPaid: afterPaid, paidBefore: beforePaid, paidAfter: afterPaid, amountThisTime,
        totalAmount: after.totalAmount, remainingAmount: after.remainingAmount,
        cashAmount: after.cashAmount, wechatAmount: after.wechatAmount, alipayAmount: after.alipayAmount,
        companionWorkers: after.companionWorkers || '', note: data.note || data.correctionReason || '',
        photos: operationPhotos
      }, ...(Array.isArray(order.paymentLogs) ? order.paymentLogs : [])];
      const eventType = isCorrection ? 'AMOUNT_CORRECTION' : (operationType === 'full_payment' ? 'FULL_PAYMENT' : (operationType === 'deposit_payment' ? 'DEPOSIT_PAYMENT' : (operationType === 'final_payment' ? 'FINAL_PAYMENT' : 'ADDITIONAL_PAYMENT')));
      const paymentData = { paymentId, operationId, orderId, operationType, city: order.city || '', workerId: order.workerId || '', workerName: order.workerName || '', workerPhone: order.workerPhone || '', source: order.source || '', creatorId: order.creatorId || '', creatorName: order.creatorName || '', paidBefore: beforePaid, amountThisTime, paidAfter: afterPaid, totalAmount: Number(after.totalAmount || afterPaid), remainingBefore: Number(order.remainingAmount || 0), remainingAfter: Number(after.remainingAmount || 0), cashBefore: Number(order.cashAmount || 0), cashAfter: Number(after.cashAmount || 0), wechatBefore: Number(order.wechatAmount || 0), wechatAfter: Number(after.wechatAmount || 0), alipayBefore: Number(order.alipayAmount || 0), alipayAfter: Number(after.alipayAmount || 0), correctionReason: String(data.correctionReason || ''), note: String(data.note || ''), operatorId: user._id, operatorName: user.name || '', operatorRole: user.role, createdAt: now };
      const notificationSnapshot = paymentNotificationSnapshot(order, after, { eventType, operationType, amountThisTime, paidBefore: beforePaid, paymentChannelCorrected: channelsChanged && beforePaid === afterPaid, correctionReason: String(data.correctionReason || data.note || '') });
      const eventData = { eventId: 'evt_' + paymentId, eventKey: `order:${orderId}:payment:${paymentId}`, orderId, eventType, groupType: 'deal', city: order.city, paymentId, operationId, actorId: user._id, actorRole: user.role, isTestEvent: user.isTest === true, notificationSnapshot, status: 'PENDING', nextRetryAt: new Date(Date.now() + 60000).toISOString(), createdAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
      try {
        const clientExpectedVersion = readExpectedVersion(event, data);
        const expectedVersion = clientExpectedVersion === null ? Number(order.version || 0) : clientExpectedVersion;
        await commitPaymentTransaction(orderId, expectedVersion, after, paymentData, eventData);
      } catch (error) {
        if (error.code === 'ORDER_VERSION_CONFLICT') {
          // 同一 operationId 可能已经由第一次请求成功提交，只是客户端没有收到响应。
          const committed = await db.collection('payment_transactions').where({ orderId, operationId }).limit(1).get().catch(() => ({ data: [] }));
          if (committed.data && committed.data[0]) return { success: true, duplicate: true, paymentId: committed.data[0].paymentId, msg: '订单已保存，未重复入账' };
          return { success: false, code: error.code, msg: error.message };
        }
        if (error.code === 'INVALID_ORDER_VERSION') return { success: false, code: error.code, msg: error.message };
        throw error;
      }
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
      const operationId = String(data && data.operationId || '').trim();
      if (!/^fbop_[A-Za-z0-9_-]{8,100}$/.test(operationId)) return { success: false, code: 'FEEDBACK_OPERATION_ID_REQUIRED', msg: '回馈请求标识无效，请重新打开回馈窗口' };
      const existingOperation = await getFeedbackOperation(operationId);
      if (existingOperation) {
        if (String(existingOperation.orderId || '') !== String(orderId) || String(existingOperation.actorId || '') !== String(user._id || '')) {
          return { success: false, code: 'FEEDBACK_OPERATION_ID_CONFLICT', msg: '回馈请求标识冲突，请重新打开回馈窗口' };
        }
        return { success: true, duplicate: true, version: Number(existingOperation.resultVersion || 0), feedbackId: existingOperation.feedbackId || '' };
      }
      const feedbackPhotos = normalizePhotos(data && data.photos, 9);
      const feedbackPhotoValidation = await validateTrackedOperationFiles(user, orderId, operationId, 'feedback', feedbackPhotos);
      if (!feedbackPhotoValidation.success) return feedbackPhotoValidation;
      const newFeedback = feedbackInput({ ...data, photos: feedbackPhotoValidation.fileIDs }, user);
      if (!newFeedback.content) return { success: false, msg: '请输入回馈说明' };
      const expectedVersion = readExpectedVersion(event, data);
      try {
        const result = await commitFeedbackTransaction(orderId, expectedVersion, operationId, newFeedback, user);
        return { success: true, duplicate: result.duplicate === true, version: result.version, feedbackId: result.feedbackId };
      } catch (error) {
        const response = mutationErrorResponse(error);
        if (response) return response;
        if (error.code === 'FEEDBACK_OPERATION_ID_CONFLICT') return { success: false, code: error.code, msg: error.message };
        throw error;
      }
    } else return { success: false, msg: '未知操作类型' };
    return { success: true };
  } catch (err) {
    console.error('云函数处理异常：', err);
    return { success: false, msg: '云端处理失败', error: err.message || String(err) };
  }
};
