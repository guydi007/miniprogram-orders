const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { action, orderId, orderIds, userId, data } = event;
  const wxContext = cloud.getWXContext();

  try {
    // 1. 批量指派师傅（主管专用）
    if (action === 'batchAssignWorker') {
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return { success: false, msg: '缺少待指派的订单列表' };
      }
      await db.collection('orders').where({
        _id: _.in(orderIds)
      }).update({
        data: {
          workerName: data.workerName || '',
          workerPhone: data.workerPhone || '',
          workerGroupId: data.workerGroupId || '',
          status: '已派单',
          assignTime: new Date().toISOString()
        }
      });
      return { success: true };
    }

    // 2. 更新员工信息（开放所有字段：姓名、手机号、角色、城市、群号、测试号）
    if (action === 'updateUser') {
      if (!userId) {
        return { success: false, msg: '缺少员工ID' };
      }
      const updatePayload = {};
      if (data.name !== undefined) updatePayload.name = data.name;
      if (data.phone !== undefined) updatePayload.phone = data.phone;
      if (data.role !== undefined) updatePayload.role = data.role;
      if (data.cities !== undefined) updatePayload.cities = data.cities;
      if (data.groupId !== undefined) updatePayload.groupId = data.groupId;
      if (data.isTest !== undefined) updatePayload.isTest = Boolean(data.isTest);

      await db.collection('users').doc(userId).update({
        data: updatePayload
      });
      return { success: true };
    }

    // 3. 解绑员工微信号
    if (action === 'unbindUser') {
      if (!userId) {
        return { success: false, msg: '缺少员工ID' };
      }
      await db.collection('users').doc(userId).update({
        data: { openid: '' }
      });
      return { success: true };
    }

    // 4. 单独更新工单（派单/改派/标记未成单等）
    if (action === 'updateOrder') {
      if (!orderId) {
        return { success: false, msg: '缺少订单ID' };
      }
      await db.collection('orders').doc(orderId).update({
        data: data || {}
      });
      return { success: true };
    }

    // 5. 催单
    if (action === 'urgent') {
      if (!orderId) return { success: false, msg: '缺少订单ID' };
      await db.collection('orders').doc(orderId).update({
        data: { isUrgent: true }
      });
      return { success: true };
    }

    // 6. 预约改期
    if (action === 'editTime') {
      if (!orderId) return { success: false, msg: '缺少订单ID' };
      await db.collection('orders').doc(orderId).update({
        data: data || {}
      });
      return { success: true };
    }

    // 7. 取消工单
    if (action === 'cancelOrder') {
      if (!orderId) return { success: false, msg: '缺少订单ID' };
      await db.collection('orders').doc(orderId).update({
        data: data || {}
      });
      return { success: true };
    }

    // 8. 完工结单 / 预付款结算
    if (action === 'finishOrder') {
      if (!orderId) return { success: false, msg: '缺少订单ID' };
      await db.collection('orders').doc(orderId).update({
        data: data || {}
      });
      return { success: true };
    }

    // 9. 进度回馈
    if (action === 'feedback') {
      if (!orderId) return { success: false, msg: '缺少订单ID' };
      await db.collection('orders').doc(orderId).update({
        data: data || {}
      });
      return { success: true };
    }

    return { success: false, msg: '未知操作类型' };
  } catch (err) {
    console.error('云函数处理异常：', err);
    return { success: false, error: err };
  }
};