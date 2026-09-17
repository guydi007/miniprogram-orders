const { recipients, notifyGroup, postWebhook } = require('./groupNotifications');
const templates = require('./notificationTemplates.json');

function getNotificationConfig(user) {
  return [];
}

function receiverOpenid(user) {
  if (!user.isTest) return user.openid || '';
  const cutoff = Date.now() - 24 * 3600000;
  return user.testSessionOpenid && new Date(user.testSessionTime).getTime() > cutoff ? user.testSessionOpenid : '';
}

function templateData(type, order) {
  const values = {
    address: order.address || '服务地址待确认', reason: '客户催促，请尽快联系处理',
    city: order.city, appointmentTime: order.appointmentTime, source: order.source,
    status: order.status, workerName: order.workerName, creatorName: order.creatorName,
    orderId: order._id
  };
  const data = {};
  Object.entries(templates[type].fields).forEach(([field, source]) => {
    const raw = String(values[source] || '待确认').replace(/[\r\n]/g, ' ');
    // thing 字段按 Unicode 字符截断，避免截断 emoji 的代理对。
    data[field] = { value: /^thing\d+$/.test(field) ? Array.from(raw).slice(0, 20).join('') : raw };
  });
  return data;
}

async function notifyAll(cloud, db, type, order, operator, sendWebhook = postWebhook) {
  return { success: true, status: 'SUPPRESSED', sent: 0, missing: 0, msg: '个人订阅通知已停用，请使用企业微信群' };
  /* legacy implementation retained below for historical compatibility */
  const summary = { success: false, sent: 0, missing: 0, results: [], subscription: [], webhook: null };
  try {
    const users = await recipients(db, type, order, operator);
    const config = templates[type];
    const configured = Boolean(config && config.templateId && Object.keys(config.fields).length);
    summary.subscription = await Promise.all(users.map(async user => {
      const result = { recipientIds: [user._id], success: false };
      const openid = receiverOpenid(user);
      if (!configured) return { ...result, code: 'TEMPLATE_NOT_CONFIGURED' };
      if (!openid) return { ...result, code: 'NO_RECEIVER_OPENID' };
      try {
        const response = await cloud.openapi.subscribeMessage.send({
          touser: openid, templateId: config.templateId,
          page: `pages/detail/detail?id=${encodeURIComponent(order._id)}`,
          miniprogramState: templates.miniprogramState,
          data: templateData(type, order)
        });
        if (!response) return { ...result, code: 'EMPTY_SEND_RESPONSE' };
        if (response && ((response.errCode !== undefined && Number(response.errCode) !== 0) ||
            (response.errcode !== undefined && Number(response.errcode) !== 0))) {
          return { ...result, code: Number(response.errCode || response.errcode) };
        }
        return { ...result, success: true };
      } catch (error) {
        return { ...result, code: error.errCode || error.errcode || 'SUBSCRIBE_SEND_FAILED' };
      }
    }));
    const delivered = new Set(summary.subscription.filter(result => result.success).flatMap(result => result.recipientIds));
    const fallback = users.filter(user => !delivered.has(user._id) && user.webhookUrl);
    // Webhook 可选；仅对订阅消息失败的收件人使用已配置的群通道。
    if (fallback.length) {
      summary.webhook = await notifyGroup(db, type, order, operator, sendWebhook, fallback);
      (summary.webhook.results || []).filter(result => result.success).forEach(result => result.recipientIds.forEach(id => delivered.add(id)));
    }
    summary.sent = delivered.size;
    summary.missing = users.length - delivered.size;
    summary.results = users.map(user => ({ recipientIds: [user._id], success: delivered.has(user._id) }));
    summary.success = users.length > 0 && summary.missing === 0;
    summary.msg = users.length === 0 ? '未找到匹配的接收人员' : (summary.success ? '提醒已发送' : '部分提醒未发送，请人工联系');
  } catch (error) {
    summary.msg = '提醒处理失败，请人工联系';
  }
  // 仅记录状态和错误码，不保存 OpenID、模板内容或 Webhook 密钥。
  try {
    await db.collection('orders').doc(order._id).update({ data: {
      notificationLogs: db.command.push({ type, time: new Date().toISOString(), operatorId: operator._id, ...summary })
    } });
  } catch (error) { summary.logSaved = false; }
  return summary;
}

module.exports = { notifyAll, getNotificationConfig, receiverOpenid, templateData };
