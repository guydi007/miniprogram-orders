const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

// 模版编号: 32556 (催单提醒)
const URGENT_TEMPLATE_ID = 'h2xwE4YRkuI4r-DmVqJHVpN_l_YSTdKMutIg0Lmwrug';

exports.main = async (event) => {
  const { workerName, order, reason } = event;
  const db = cloud.database();

  try {
    // 1. 根据师傅姓名查询对应用户的 openid
    const userRes = await db.collection('users').where({
      name: workerName,
      role: 'worker'
    }).get();

    if (!userRes.data || userRes.data.length === 0) {
      return { success: false, msg: '未找到该师傅信息' };
    }

    const workerUser = userRes.data[0];
    const targetOpenid = workerUser.openid || workerUser._openid;

    if (!targetOpenid) {
      return { 
        success: false, 
        msg: '该师傅尚未在小程序中点击“开启私信通知”授权' 
      };
    }

    // 2. 微信规则保护：thing 字段长度限制最多 20 个汉字/字符，进行安全截断
    const shortAddress = (order.address || '现场服务地址').slice(0, 20);
    const shortReason = (reason || '客户催促尽快上门处理').slice(0, 20);

    // 3. 1对1精准下发至师傅微信【服务通知】
    const sendResult = await cloud.openapi.subscribeMessage.send({
      touser: targetOpenid,
      templateId: URGENT_TEMPLATE_ID,
      page: `pages/detail/detail?id=${order._id}`, // 师傅点击卡片直接跳入该工单
      miniprogramState: 'developer', // 开发/真机调试阶段用 developer，正式发布后换为 formal
      data: {
        thing9: {
          value: shortAddress  // 订单地址 (最多20字)
        },
        thing4: {
          value: shortReason   // 催单原因 (最多20字)
        }
      }
    });

    console.log('订阅消息下发成功:', sendResult);
    return { success: true, sendResult };
  } catch (err) {
    console.error('订阅消息下发失败:', err);
    return { success: false, error: err };
  }
};