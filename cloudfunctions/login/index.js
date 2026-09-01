const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const currentOpenid = wxContext.OPENID;
  const { action, phone } = event;

  // 1. 默认仅获取 OpenID
  if (!action) {
    return {
      openid: currentOpenid,
      appid: wxContext.APPID
    };
  }

  // 2. 手机号核验与安全绑定
  if (action === 'verifyAndBind') {
    if (!phone) {
      return { success: false, msg: '请输入手机号' };
    }

    try {
      const userRes = await db.collection('users').where({ phone: phone }).get();
      if (!userRes.data || userRes.data.length === 0) {
        return { success: false, msg: '未找到该员工记录，请联系管理员录入' };
      }

      const user = userRes.data[0];

      // 🌟 方案 1 核心：如果是测试账号 (isTest === true)，完全不绑定、不校验 OpenID，直接放行
      if (user.isTest === true) {
        return {
          success: true,
          user: user
        };
      }

      // --- 以下为正式员工锁定逻辑 ---
      const hasBoundOpenid = user.openid && user.openid.trim() !== '';

      // 账号已被其他微信号绑定 -> 拦截
      if (hasBoundOpenid && user.openid !== currentOpenid) {
        return { 
          success: false, 
          msg: `员工【${user.name}】已被其他微信号绑定！如需更换，请联系管理员解绑` 
        };
      }

      // 未绑定 -> 由云端管理员权限安全写入 OpenID 锁定
      if (!hasBoundOpenid && currentOpenid) {
        await db.collection('users').doc(user._id).update({
          data: { openid: currentOpenid }
        });
        user.openid = currentOpenid;
      }

      return {
        success: true,
        user: user
      };
    } catch (err) {
      return { success: false, msg: '数据库查询异常', error: err };
    }
  }

  return { openid: currentOpenid };
};