const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PHONE_RE = /^1\d{10}$/;
const TEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const clientUser = user => user ? ({
  _id: user._id,
  name: user.name || '',
  phone: user.phone || '',
  role: user.role || '',
  cities: Array.isArray(user.cities) ? user.cities : (typeof user.cities === 'string' && user.cities ? [user.cities] : []),
  isTest: user.isTest === true,
  openid: Boolean(user.openid)
}) : null;

const openidBindingId = openid =>
  crypto.createHash('sha256').update(String(openid || '')).digest('hex').slice(0, 40);

async function findUniqueUserByPhone(phone) {
  const normalizedPhone = String(phone || '').trim();
  if (!PHONE_RE.test(normalizedPhone)) {
    return { error: { success: false, code: 'INVALID_PHONE', msg: '请输入正确的11位手机号' } };
  }

  const userRes = await db.collection('users').where({ phone: normalizedPhone }).limit(2).get();
  const users = userRes.data || [];
  if (users.length === 0) {
    return { error: { success: false, code: 'USER_NOT_FOUND', msg: '未找到该员工记录，请联系管理员录入' } };
  }
  if (users.length !== 1) {
    return { error: { success: false, code: 'DUPLICATE_PHONE', msg: '员工手机号数据异常，请联系管理员处理重复记录' } };
  }
  return { user: users[0], phone: normalizedPhone };
}

async function startTestSession(user, currentOpenid) {
  // 同一个微信同时只保留一个测试账号会话；测试账号不占用正式 openid 绑定。
  await db.collection('users').where({
    isTest: true,
    testSessionOpenid: currentOpenid
  }).update({ data: { testSessionOpenid: '', testSessionTime: '' } });

  const now = new Date().toISOString();
  await db.collection('users').doc(user._id).update({
    data: {
      testSessionOpenid: currentOpenid,
      testSessionTime: now
    }
  });
  user.testSessionOpenid = currentOpenid;
  user.testSessionTime = now;
  return { success: true, nextStep: 'DONE', user: clientUser(user) };
}

async function bindFormalUser(user, currentOpenid) {
  // 兼容旧数据：如果 users 表中已有其他正式员工占用当前 OpenID，直接拒绝，不猜身份。
  const legacyBound = await db.collection('users').where({ openid: currentOpenid }).limit(2).get();
  const otherBoundUser = (legacyBound.data || []).find(item => String(item._id) !== String(user._id));
  if (otherBoundUser) {
    return {
      success: false,
      code: 'OPENID_BOUND_TO_OTHER_USER',
      msg: `当前微信号已绑定员工【${otherBoundUser.name || '其他员工'}】，请先由管理员解绑`
    };
  }

  const bindingId = openidBindingId(currentOpenid);
  const transaction = await db.startTransaction();
  try {
    const latest = await transaction.collection('users').doc(user._id).get();
    const current = latest.data;
    if (!current) throw new Error('员工记录不存在');
    if (current.isTest === true) {
      await transaction.rollback();
      return { success: false, code: 'ACCOUNT_TYPE_CHANGED', msg: '账号类型已变化，请重新登录' };
    }

    const boundOpenid = String(current.openid || '').trim();
    if (boundOpenid && boundOpenid !== currentOpenid) {
      await transaction.rollback();
      return {
        success: false,
        code: 'USER_BOUND_TO_OTHER_OPENID',
        msg: `员工【${current.name}】已被其他微信号绑定！如需更换，请联系管理员解绑`
      };
    }

    const bindingResult = await transaction.collection('openid_bindings').doc(bindingId).get().catch(() => ({ data: null }));
    const binding = bindingResult.data;
    if (binding && String(binding.userId || '') !== String(user._id)) {
      await transaction.rollback();
      return { success: false, code: 'OPENID_BOUND_TO_OTHER_USER', msg: '当前微信号已绑定其他员工，请先由管理员解绑' };
    }

    if (!boundOpenid) {
      await transaction.collection('users').doc(user._id).update({ data: { openid: currentOpenid } });
    }
    if (!binding) {
      await transaction.collection('openid_bindings').doc(bindingId).set({ data: {
        userId: user._id,
        createdAt: new Date().toISOString()
      } });
    }

    await transaction.commit();
    user.openid = currentOpenid;
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { /* 事务可能已提交或已回滚 */ }

    // 并发绑定时，以绑定登记的最终状态为准。
    const binding = await db.collection('openid_bindings').doc(bindingId).get().catch(() => ({ data: null }));
    if (binding.data && String(binding.data.userId || '') !== String(user._id)) {
      return { success: false, code: 'OPENID_BOUND_TO_OTHER_USER', msg: '当前微信号已绑定其他员工，请先由管理员解绑' };
    }
    throw error;
  }

  // 正式账号登录后结束当前微信的测试会话，避免后端继续优先使用测试身份。
  await db.collection('users').where({
    isTest: true,
    testSessionOpenid: currentOpenid
  }).update({ data: { testSessionOpenid: '', testSessionTime: '' } });

  return { success: true, nextStep: 'DONE', user: clientUser(user) };
}

async function beginLogin(phone, currentOpenid) {
  if (!currentOpenid) return { success: false, code: 'NO_OPENID', msg: '无法获取当前微信身份，请重新进入小程序' };

  const found = await findUniqueUserByPhone(phone);
  if (found.error) return found.error;
  const user = found.user;

  // 账号类型完全由后台 users.isTest 判断，前台不再让用户选择登录方式。
  if (user.isTest === true) {
    return startTestSession(user, currentOpenid);
  }

  // 正式账号先只返回下一步要求。微信手机号授权必须由用户点击按钮触发。
  return {
    success: true,
    nextStep: 'WECHAT_PHONE',
    code: 'WECHAT_PHONE_REQUIRED',
    msg: '该员工为正式账号，请授权微信手机号完成身份核验'
  };
}

async function verifyWechatPhone(phoneCode, requestedPhone, currentOpenid) {
  if (!currentOpenid) return { success: false, code: 'NO_OPENID', msg: '无法获取当前微信身份，请重新进入小程序' };
  if (!phoneCode) return { success: false, code: 'PHONE_CODE_REQUIRED', msg: '请允许微信手机号授权' };

  const requested = String(requestedPhone || '').trim();
  if (!PHONE_RE.test(requested)) {
    return { success: false, code: 'INVALID_PHONE', msg: '登录手机号已失效，请重新输入员工手机号' };
  }

  const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code: phoneCode });
  const verifiedPhone = String(phoneResult && phoneResult.phoneInfo && phoneResult.phoneInfo.phoneNumber || '').trim();
  if (!PHONE_RE.test(verifiedPhone)) {
    return { success: false, code: 'WECHAT_PHONE_UNAVAILABLE', msg: '未能获取微信授权手机号，请重试' };
  }

  // 用户先选择的员工手机号，必须与微信授权返回的真实手机号一致。
  if (verifiedPhone !== requested) {
    return {
      success: false,
      code: 'PHONE_MISMATCH',
      msg: '微信授权手机号与员工预留手机号不一致，请确认账号或联系管理员'
    };
  }

  const found = await findUniqueUserByPhone(requested);
  if (found.error) return found.error;
  const user = found.user;
  if (user.isTest === true) {
    return { success: false, code: 'ACCOUNT_TYPE_CHANGED', msg: '账号类型已变化，请重新登录' };
  }

  return bindFormalUser(user, currentOpenid);
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const currentOpenid = String(wxContext.OPENID || '').trim();
  const { action, phone, phoneCode } = event;

  // 默认：返回当前微信身份和仍有效的测试会话。
  if (!action) {
    let testUser = null;
    if (currentOpenid) {
      const cutoff = new Date(Date.now() - TEST_SESSION_TTL_MS).toISOString();
      const testRes = await db.collection('users').where({
        isTest: true,
        testSessionOpenid: currentOpenid,
        testSessionTime: db.command.gt(cutoff)
      }).limit(1).get();
      testUser = testRes.data && testRes.data[0] ? testRes.data[0] : null;
    }
    return {
      openid: currentOpenid,
      appid: wxContext.APPID,
      user: clientUser(testUser)
    };
  }

  try {
    // 新版统一入口：先输入员工手机号，后台决定测试账号直接登录还是正式账号继续微信核验。
    if (action === 'beginLogin') {
      return await beginLogin(phone, currentOpenid);
    }

    // 新版正式账号第二步：仅后台已经判定为正式账号后才走微信手机号授权。
    if (action === 'verifyWechatPhone') {
      return await verifyWechatPhone(phoneCode, phone, currentOpenid);
    }

    // 兼容旧客户端：保留旧 action，避免未升级客户端立即失效。
    if (action === 'verifyAndBind') {
      if (phoneCode) {
        const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code: phoneCode });
        const verifiedPhone = String(phoneResult && phoneResult.phoneInfo && phoneResult.phoneInfo.phoneNumber || '').trim();
        if (!PHONE_RE.test(verifiedPhone)) return { success: false, msg: '未能获取微信授权手机号，请重试' };
        const found = await findUniqueUserByPhone(verifiedPhone);
        if (found.error) return found.error;
        if (found.user.isTest === true) return startTestSession(found.user, currentOpenid);
        return bindFormalUser(found.user, currentOpenid);
      }

      const found = await findUniqueUserByPhone(phone);
      if (found.error) return found.error;
      if (found.user.isTest === true) return startTestSession(found.user, currentOpenid);
      return { success: false, code: 'WECHAT_PHONE_REQUIRED', msg: '正式账号请使用微信手机号授权登录' };
    }
  } catch (err) {
    console.error('员工登录/手机号核验异常：', err);
    return { success: false, code: 'LOGIN_INTERNAL_ERROR', msg: '登录服务异常，请稍后重试' };
  }

  return { success: false, code: 'UNKNOWN_ACTION', msg: '未知登录操作' };
};
