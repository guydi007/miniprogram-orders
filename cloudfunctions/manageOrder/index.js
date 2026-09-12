const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const fields = {
  assign: ['workerName', 'workerPhone', 'workerGroupId'],
  editTime: ['appointmentTime', 'appointmentLogs', 'feedbacks', 'isUrgent'],
  cancel: ['uncompletedType', 'cancelReason', 'cancelTime', 'isUrgent'],
  finish: ['status', 'settleType', 'cashAmount', 'wechatAmount', 'alipayAmount', 'finalAmount', 'depositAmount', 'totalAmount', 'remainingAmount', 'companionWorkers', 'finishPhotos', 'finishNote', 'paymentLogs', 'isUrgent', 'finishTime'],
  feedback: ['feedbacks']
};

function pick(value, allowed) {
  const out = {};
  const input = value && typeof value === 'object' ? value : {};
  allowed.forEach(key => { if (input[key] !== undefined) out[key] = input[key]; });
  return out;
}

async function currentUser() {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return null;
  const res = await db.collection('users').where({ openid }).limit(1).get();
  if (res.data && res.data[0]) return res.data[0];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const testRes = await db.collection('users').where({
    isTest: true,
    testSessionOpenid: openid,
    testSessionTime: _.gt(cutoff)
  }).limit(1).get();
  return testRes.data && testRes.data[0] || null;
}

const hasRole = (user, roles) => Boolean(user && roles.includes(user.role));
const canAccess = (user, order) => {
  if (user.role === 'admin') return true;
  if (user.role === 'worker') return order.workerName === user.name;
  const cities = Array.isArray(user.cities) ? user.cities : [];
  return !order.city || cities.includes(order.city);
};

exports.main = async (event = {}) => {
  const { action, orderId, orderIds, userId, data } = event;
  try {
    const user = await currentUser();
    if (!user) return { success: false, code: 'UNAUTHORIZED', msg: '登录已失效，请重新登录' };

    if (action === 'createOrder') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无录单权限' };
      const payload = pick(data, ['city', 'customerPhone', 'address', 'appointmentTime', 'source', 'workerName', 'workerPhone', 'workerGroupId', 'totalAmount', 'paidAmount', 'pendingBalance', 'feedbacks']);
      const cities = Array.isArray(user.cities) ? user.cities : [];
      if (payload.city && cities.length && !cities.includes(payload.city)) return { success: false, msg: '无权录入该城市工单' };
      Object.assign(payload, { creatorName: user.name, createTime: new Date().toISOString(), status: payload.workerName ? '已派单' : '待派单' });
      const result = await db.collection('orders').add({ data: payload });
      return { success: true, orderId: result._id };
    }

    if (action === 'batchAssignWorker') {
      if (!hasRole(user, ['leader'])) return { success: false, msg: '仅主管可批量派单' };
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 100) return { success: false, msg: '工单列表无效' };
      const result = await db.collection('orders').where({ _id: _.in(orderIds), status: _.nin(['已完工', '未成单']) }).update({
        data: { ...pick(data, fields.assign), status: '已派单', assignTime: new Date().toISOString() }
      });
      return { success: true, updated: result.stats && result.stats.updated };
    }

    if (action === 'updateUser' || action === 'unbindUser') {
      if (!hasRole(user, ['admin'])) return { success: false, msg: '仅管理员可管理员工' };
      if (!userId) return { success: false, msg: '缺少员工ID' };
      if (action === 'unbindUser') await db.collection('users').doc(userId).update({ data: { openid: '' } });
      else {
        const payload = pick(data, ['name', 'phone', 'role', 'cities', 'groupId', 'isTest']);
        if (payload.role && !['admin', 'leader', 'service', 'worker'].includes(payload.role)) return { success: false, msg: '角色无效' };
        if (payload.isTest !== undefined) payload.isTest = Boolean(payload.isTest);
        await db.collection('users').doc(userId).update({ data: payload });
      }
      return { success: true };
    }

    if (!orderId) return { success: false, msg: '缺少订单ID' };
    const orderRes = await db.collection('orders').doc(orderId).get();
    const order = orderRes.data;
    if (!order || !canAccess(user, order)) return { success: false, msg: '无权访问该工单' };

    if (action === 'updateOrder') {
      if (!hasRole(user, ['leader'])) return { success: false, msg: '仅主管可派单' };
      if (['已完工', '未成单'].includes(order.status)) return { success: false, msg: '归档工单不可改派' };
      await db.collection('orders').doc(orderId).update({ data: { ...pick(data, fields.assign), status: '已派单', assignTime: new Date().toISOString() } });
    } else if (action === 'urgent') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无催单权限' };
      await db.collection('orders').doc(orderId).update({ data: { isUrgent: true, urgentTime: new Date().toISOString() } });
    } else if (action === 'editTime') {
      if (!hasRole(user, ['service', 'leader', 'worker'])) return { success: false, msg: '无改期权限' };
      if (['已完工', '未成单'].includes(order.status)) return { success: false, msg: '归档工单不可改期' };
      if (!data || typeof data.appointmentTime !== 'string' || !data.appointmentTime.trim()) return { success: false, msg: '请输入预约时间' };
      await db.collection('orders').doc(orderId).update({ data: pick(data, fields.editTime) });
    } else if (action === 'cancelOrder') {
      if (!hasRole(user, ['service', 'leader'])) return { success: false, msg: '无取消权限' };
      await db.collection('orders').doc(orderId).update({ data: { ...pick(data, fields.cancel), status: '未成单' } });
    } else if (action === 'finishOrder') {
      if (!(user.role === 'worker' && order.workerName === user.name) && !hasRole(user, ['leader'])) return { success: false, msg: '无结算权限' };
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
