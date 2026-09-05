const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { action, orderId, orderIds, userId, data } = event;

  // 1. 单个工单修改动作
  if (['cancelOrder', 'updateOrder', 'assignWorker', 'finishOrder', 'editTime', 'feedback', 'urgent'].includes(action)) {
    try {
      const res = await db.collection('orders').doc(orderId).update({
        data: data
      });
      return {
        success: true,
        updated: res.stats ? res.stats.updated : 1
      };
    } catch (err) {
      console.error('云端更新工单失败：', err);
      return {
        success: false,
        error: err
      };
    }
  }

  // 🌟 2. 批量指派工单给同一个师傅
  if (action === 'batchAssignWorker') {
    try {
      const ids = orderIds || [];
      const tasks = ids.map(id => 
        db.collection('orders').doc(id).update({
          data: data
        })
      );
      await Promise.all(tasks);
      return {
        success: true,
        updated: ids.length
      };
    } catch (err) {
      console.error('云端批量派单失败：', err);
      return {
        success: false,
        error: err
      };
    }
  }

  // 3. 员工账号相关修改动作
  if (['updateUser', 'unbindUser'].includes(action)) {
    try {
      const res = await db.collection('users').doc(userId).update({
        data: data
      });
      return {
        success: true,
        updated: res.stats ? res.stats.updated : 1
      };
    } catch (err) {
      console.error('云端更新用户失败：', err);
      return {
        success: false,
        error: err
      };
    }
  }

  return {
    success: false,
    msg: '未知指令'
  };
};