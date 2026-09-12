const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const currentOpenid = wxContext.OPENID;
  const { action, phone } = event;

  // 1. 默认仅获取 OpenID
  if (!action) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const testRes = await db.collection('users').where({
      isTest: true,
      testSessionOpenid: currentOpenid,
      testSessionTime: db.command.gt(cutoff)
    }).limit(1).get();
    return {
      openid: currentOpenid,
      appid: wxContext.APPID,
      user: testRes.data && testRes.data[0] ? testRes.data[0] : null
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

      // 测试账号保持免绑定；只记录当前测试会话，可随时切换，不占用正式 openid 字段。
      if (user.isTest === true) {
        await db.collection('users').where({
          isTest: true,
          testSessionOpenid: currentOpenid
        }).update({ data: { testSessionOpenid: '', testSessionTime: '' } });
        await db.collection('users').doc(user._id).update({
          data: {
            testSessionOpenid: currentOpenid,
            testSessionTime: new Date().toISOString()
          }
        });
        user.testSessionOpenid = currentOpenid;
        return { success: true, user };
      }

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

      // 切回正式账号时结束当前微信的测试会话，避免后端仍使用测试身份。
      await db.collection('users').where({
        isTest: true,
        testSessionOpenid: currentOpenid
      }).update({ data: { testSessionOpenid: '', testSessionTime: '' } });
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
