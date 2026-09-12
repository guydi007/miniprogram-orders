const https = require('https');

function parseWebhook(value) {
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.hostname !== 'qyapi.weixin.qq.com' ||
      target.pathname !== '/cgi-bin/webhook/send' || !target.searchParams.get('key') ||
      target.username || target.password || target.port || target.hash) {
    throw new Error('机器人地址必须是企业微信官方 HTTPS Webhook');
  }
  return target;
}

function postWebhook(webhook, message) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = parseWebhook(webhook); } catch (error) { reject(error); return; }
    const payload = JSON.stringify(message);
    const req = https.request(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('机器人响应过大')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200 || result.errcode !== 0) throw new Error('机器人拒绝消息，错误码：' + (result.errcode === undefined ? res.statusCode : result.errcode));
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('机器人请求超时')), 3000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

function citiesOf(user) {
  if (Array.isArray(user.cities)) return user.cities;
  if (typeof user.cities === 'string') return [user.cities];
  return user.cities && typeof user.cities === 'object' ? Object.values(user.cities) : [];
}

async function recipients(db, type, order, operator) {
  let list;
  if (type === 'urgent') {
    if (!order.workerName && !order.workerPhone) return [];
    const query = order.workerPhone ? { phone: order.workerPhone } : { name: order.workerName };
    const result = await db.collection('users').where(query).limit(100).get();
    list = (result.data || []).filter(user => ['worker', 'leader'].includes(user.role));
    // 不根据同名员工猜收件人，避免错发客户资料。
    if (list.length !== 1) return [];
  } else {
    list = [];
    for (let skip = 0; ; skip += 100) {
      const result = await db.collection('users').where({ role: 'leader' }).skip(skip).limit(100).get();
      list.push(...(result.data || []));
      if (!result.data || result.data.length < 100) break;
    }
    list = list.filter(user => order.city && citiesOf(user).includes(order.city));
  }
  // 测试操作不通知正式人员；测试人员需单独配置测试群地址。
  return operator.isTest ? list.filter(user => user.isTest === true) : list.filter(user => user.isTest !== true);
}

function contentFor(type, order, operator) {
  const clean = value => String(value || '未填写').replace(/[\r\n]/g, ' ').slice(0, 200);
  const title = type === 'urgent' ? '客户催单提醒' : '新工单待查看';
  const lines = [
    `${operator.isTest ? '【测试】' : ''}【${title}】`,
    `工单：${clean(order._id)}`, `城市：${clean(order.city)}`,
    `预约时间：${clean(order.appointmentTime)}`, `地址：${clean(order.address)}`,
    `操作人：${clean(operator.name)}`
  ];
  if (type === 'urgent') lines.push(`接单人员：${clean(order.workerName)}`, '请及时打开小程序查看工单并联系客户。');
  else lines.push(`来源：${clean(order.source)}`, `状态：${clean(order.status)}`, '请主管打开小程序查看并安排派单。');
  return lines.join('\n');
}

async function notifyGroup(db, type, order, operator, send = postWebhook, suppliedUsers) {
  let summary;
  try {
    const users = suppliedUsers || await recipients(db, type, order, operator);
    const groups = new Map();
    const missing = users.filter(user => !user.webhookUrl).length;
    users.filter(user => user.webhookUrl).forEach(user => {
      if (!groups.has(user.webhookUrl)) groups.set(user.webhookUrl, []);
      groups.get(user.webhookUrl).push(user);
    });
    const results = await Promise.all(Array.from(groups, async ([webhook, members]) => {
      const message = { msgtype: 'text', text: { content: contentFor(type, order, operator) } };
      const mobiles = [...new Set(members.map(user => user.phone).filter(phone => /^1\d{10}$/.test(phone || '')))];
      if (mobiles.length) message.text.mentioned_mobile_list = mobiles;
      try {
        parseWebhook(webhook);
        await send(webhook, message);
        return { success: true, recipientIds: members.map(user => user._id) };
      } catch (error) {
        // 不保存 Webhook 或原始响应，防止泄露机器人密钥。
        return { success: false, recipientIds: members.map(user => user._id), error: error.message.startsWith('机器人') ? error.message : '机器人发送失败' };
      }
    }));
    const sent = results.filter(result => result.success).length;
    summary = { success: results.length > 0 && sent === results.length && missing === 0,
      sent, failed: results.length - sent, missing, results,
      msg: users.length === 0 ? '未找到匹配的接收人员' : (groups.size === 0 ? '接收人员未配置机器人地址' : '群通知已处理') };
  } catch (error) {
    summary = { success: false, sent: 0, failed: 0, missing: 0, msg: '通知接收人员查询失败' };
  }
  try {
    await db.collection('orders').doc(order._id).update({ data: {
      groupNotificationLogs: db.command.push({ type, time: new Date().toISOString(), operatorId: operator._id, ...summary })
    } });
  } catch (error) { summary.logSaved = false; }
  return summary;
}

module.exports = { notifyGroup, parseWebhook, postWebhook, recipients };
