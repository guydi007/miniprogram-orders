const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event, context) => {
  const { action, orderId, data } = event;

  if (action === 'cancelOrder' || action === 'updateOrder') {
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

  return {
    success: false,
    msg: '未知指令'
  };
};