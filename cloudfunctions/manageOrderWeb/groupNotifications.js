const https = require('https');
const crypto = require('crypto');

function parseWebhook(value) {
  const target = new URL(value);
  if (target.protocol !== 'https:' || target.hostname !== 'qyapi.weixin.qq.com' ||
      target.pathname !== '/cgi-bin/webhook/send' || !target.searchParams.get('key') ||
      target.username || target.password || target.port || target.hash) {
    throw new Error('机器人地址必须是企业微信官方 HTTPS Webhook');
  }
  return target;
}

function webhookFingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function maskWebhook(value) {
  const target = parseWebhook(value);
  const key = target.searchParams.get('key') || '';
  return `******${key.slice(-6)}`;
}

function normalizeGroup(group) {
  return {
    _id: group._id, city: String(group.city || '').trim(), groupName: String(group.groupName || '').trim(),
    phone: String(group.phone || '').trim(), groupType: group.groupType,
    groupTypeLabel: { order_entry: '入单群', deal: '成单群', unconverted: '未成单群' }[group.groupType] || '',
    isTestGroup: group.isTestGroup === true, enabled: group.enabled !== false,
    sort: Number(group.sort || 0), version: Number(group.version || 1),
    webhookConfigured: Boolean(group.webhookUrl), webhookMasked: group.webhookUrl ? maskWebhook(group.webhookUrl) : ''
  };
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
    // 新订单使用不可变 workerId 精确定位；历史数据缺少 workerId 时才按手机号兼容。
    if (order.workerId) {
      const result = await db.collection('users').doc(String(order.workerId)).get().catch(() => ({ data: null }));
      list = result.data && ['worker', 'leader'].includes(result.data.role) ? [result.data] : [];
    } else {
      if (!/^1\d{10}$/.test(String(order.workerPhone || ''))) return [];
      const result = await db.collection('users').where({ phone: order.workerPhone }).limit(2).get();
      list = (result.data || []).filter(user => ['worker', 'leader'].includes(user.role));
      // 历史手机号匹配必须唯一，绝不根据姓名猜收件人。
      if (list.length !== 1) return [];
    }
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
  const clean = (value, max = 100) => String(value || '无').replace(/[\x00-\x1F\r\n]/g, ' ').slice(0, max);
  const phone = clean(order.customerPhone, 11);
  const maskedPhone = /^1\d{10}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '未填写';
  const latestFeedback = Array.isArray(order.feedbacks) && order.feedbacks.length
    ? order.feedbacks[0].content || order.feedbacks[0].text || ''
    : (order.finishNote || order.note || '');
  const titleMap = {
    newOrder: '新工单通知｜入单',
    FULL_PAYMENT: '订单成交通知｜全款结清',
    DEPOSIT_PAYMENT: '订单成交通知｜预约款',
    ADDITIONAL_PAYMENT: '订单收款通知｜续款',
    FINAL_PAYMENT: '订单收款通知｜尾款结清',
    AMOUNT_CORRECTION: '订单金额通知｜金额修正',
    ONSITE_FAILED: '订单未成通知｜现场未成单',
    SERVICE_CANCELLED: '订单未成通知｜客服取消'
  };
  const eventType = order.eventType || (type === 'deal' ? 'FULL_PAYMENT' : type === 'unconverted' ? (order.uncompletedType === 'service_cancel' ? 'SERVICE_CANCELLED' : 'ONSITE_FAILED') : 'NEW_ORDER');
  const lines = [
    `${operator.isTest ? '【测试】' : ''}【${titleMap[eventType] || titleMap[type] || '订单通知'}】`,
    `客户电话：${maskedPhone}`, `预约时间：${clean(order.appointmentTime)}`,
    `服务地址：${clean(order.address)}`, `师傅：${clean(order.workerName || '待分配')}`,
    `订单来源：${clean(order.source)}`, `入单人：${clean(order.creatorName || operator.name)}`
  ];
  if (eventType === 'FULL_PAYMENT') lines.push(`金额：实收 ¥${Number(order.finalAmount || 0).toFixed(2)}（已结清）`, `反馈：${clean(latestFeedback)}`);
  else if (eventType === 'DEPOSIT_PAYMENT') lines.push(`金额：本次 ¥${Number(order.amountThisTime || 0).toFixed(2)}（累计 ¥${Number(order.depositAmount || order.finalAmount || 0).toFixed(2)}，总额 ¥${Number(order.totalAmount || 0).toFixed(2)}，待收 ¥${Number(order.remainingAmount || 0).toFixed(2)}）`, `反馈：${clean(latestFeedback)}`);
  else if (eventType === 'ADDITIONAL_PAYMENT') lines.push(`金额：本次续收 ¥${Number(order.amountThisTime || 0).toFixed(2)}（累计 ¥${Number(order.depositAmount || order.finalAmount || 0).toFixed(2)}，待收 ¥${Number(order.remainingAmount || 0).toFixed(2)}）`, `反馈：${clean(latestFeedback)}`);
  else if (eventType === 'FINAL_PAYMENT') lines.push(`金额：本次尾款 ¥${Number(order.amountThisTime || 0).toFixed(2)}（累计 ¥${Number(order.finalAmount || 0).toFixed(2)}，已结清）`, `反馈：${clean(latestFeedback)}`);
  else if (eventType === 'AMOUNT_CORRECTION') lines.push(order.paymentChannelCorrected && Number(order.paidBefore || 0) === Number(order.finalAmount || order.depositAmount || 0)
    ? `金额：实收总额 ¥${Number(order.finalAmount || order.depositAmount || 0).toFixed(2)}（支付渠道已修正）`
    : `金额：原实收 ¥${Number(order.paidBefore || 0).toFixed(2)} → 修正后 ¥${Number(order.finalAmount || order.depositAmount || 0).toFixed(2)}`, `反馈：${clean(order.correctionReason || latestFeedback)}`);
  else if (eventType === 'ONSITE_FAILED' || eventType === 'SERVICE_CANCELLED') lines.push(`反馈：${clean(order.failReason || order.cancelReason || latestFeedback)}`);
  else lines.push(`反馈：${clean(latestFeedback)}`);
  lines.push('点击小程序查看完整工单。');
  return lines.join('\n');
}

const EVENT_GROUPS = { newOrder: 'order_entry', deal: 'deal', unconverted: 'unconverted' };

function deliveryDocumentId(key) {
  const raw = `${key.eventId}|${key.groupId}|${key.webhookFingerprint}`;
  return 'delivery_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

async function claimNotificationDelivery(db, key, route) {
  const collection = db.collection('notification_deliveries');
  // 兼容历史随机 _id；新投递使用确定性文档 ID，不再依赖控制台唯一索引保证并发去重。
  const legacy = await collection.where(key).limit(1).get().catch(() => ({ data: [] }));
  const deliveryId = legacy.data && legacy.data[0] ? legacy.data[0]._id : deliveryDocumentId(key);
  const transaction = await db.startTransaction();
  try {
    let existing = null;
    try {
      const result = await transaction.collection('notification_deliveries').doc(deliveryId).get();
      existing = result.data || null;
    } catch (error) {
      existing = null;
    }

    if (existing && existing.status === 'ACCEPTED') {
      await transaction.rollback().catch(() => null);
      return { claimed: false, terminal: true, status: 'ACCEPTED', deliveryId, retryable: false };
    }
    if (existing && existing.status === 'PERMANENT_FAILED') {
      await transaction.rollback().catch(() => null);
      return { claimed: false, terminal: true, status: 'PERMANENT_FAILED', deliveryId, retryable: false };
    }

    const staleSending = existing && existing.status === 'SENDING' &&
      Date.parse(existing.lastAttemptAt || 0) < Date.now() - 60000;
    if (existing && existing.status === 'SENDING' && !staleSending) {
      await transaction.rollback().catch(() => null);
      return { claimed: false, status: 'SENDING', deliveryId, retryable: true };
    }

    const attempts = Number(existing && existing.attempts || 0) + 1;
    const leaseToken = crypto.randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    const claimData = {
      ...key,
      ...route,
      status: 'SENDING',
      attempts,
      lastAttemptAt: now,
      leaseToken
    };
    if (existing) {
      await transaction.collection('notification_deliveries').doc(deliveryId).update({ data: claimData });
    } else {
      await transaction.collection('notification_deliveries').doc(deliveryId).set({ data: claimData });
    }
    await transaction.commit();
    return { claimed: true, deliveryId, attempts, leaseToken, retryable: true };
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { /* ignore */ }
    // 同一确定性文档发生事务冲突，说明其他实例已取得发送权；本实例绝不再发送。
    return { claimed: false, status: 'SENDING', deliveryId, retryable: true };
  }
}

async function notifyConfiguredGroups(db, type, order, operator, send = postWebhook) {
  const groupType = EVENT_GROUPS[type] || type;
  const query = { city: order.city, groupType, enabled: true, isTestGroup: operator.isTest === true };
  const result = await db.collection('notification_groups').where(query).get();
  const groups = result.data || [];
  const unique = new Map();
  groups.forEach(group => {
    const webhook = String(group.webhookUrl || '').trim();
    if (webhook && !unique.has(group.webhookFingerprint || webhookFingerprint(webhook))) {
      unique.set(group.webhookFingerprint || webhookFingerprint(webhook), group);
    }
  });
  const eventId = order.eventId || `evt_${order._id}_${type}_${String(order.paymentId || 'current')}`;

  // 有匹配群配置但没有任何有效 Webhook 属于永久配置错误，绝不能把空 deliveries 的 every() 误判为 SENT。
  if (groups.length > 0 && unique.size === 0) {
    try {
      await db.collection('notification_events').where({ eventId }).update({ data: {
        status: 'PERMANENT_FAILED', errorCode: 'NO_VALID_WEBHOOK', nextRetryAt: '', updatedAt: new Date().toISOString()
      } });
    } catch (error) { /* 事件可能尚未创建 */ }
    return { success: false, status: 'PERMANENT_FAILED', retryable: false, code: 'NO_VALID_WEBHOOK', deliveries: [] };
  }

  const deliveries = await Promise.all([...unique.values()].map(async group => {
    const fingerprint = group.webhookFingerprint || webhookFingerprint(group.webhookUrl);
    const route = {
      orderCity: String(order.city || '').trim(), configuredCity: String(group.city || '').trim(),
      groupName: String(group.groupName || '').trim(), groupType: group.groupType,
      isTestEvent: operator.isTest === true, isTestGroup: group.isTestGroup === true
    };
    const key = { eventId, groupId: group._id, webhookFingerprint: fingerprint };
    const claim = await claimNotificationDelivery(db, key, route);
    if (!claim.claimed) {
      return { groupId: group._id, status: claim.status || 'SENDING', webhookFingerprint: fingerprint, ...route, retryable: claim.retryable !== false };
    }

    try {
      const message = { msgtype: 'text', text: { content: contentFor(type, order, operator) } };
      if (/^1\d{10}$/.test(group.phone || '')) message.text.mentioned_mobile_list = [group.phone];
      await send(group.webhookUrl, message);
      const accepted = await db.collection('notification_deliveries').where({
        _id: claim.deliveryId, leaseToken: claim.leaseToken, status: 'SENDING'
      }).update({ data: {
        status: 'ACCEPTED', acceptedAt: new Date().toISOString(), errorCode: '', leaseToken: ''
      } });
      // 正常 webhook 请求最多 3 秒；若租约已被替换则保守返回 SENDING，避免旧实例覆盖新实例状态。
      if (!accepted.stats || accepted.stats.updated !== 1) {
        return { groupId: group._id, status: 'SENDING', webhookFingerprint: fingerprint, ...route, retryable: true };
      }
      return { groupId: group._id, status: 'ACCEPTED', webhookFingerprint: fingerprint, ...route, retryable: false };
    } catch (error) {
      const retryable = !String(error.message || '').includes('机器人拒绝消息');
      await db.collection('notification_deliveries').where({
        _id: claim.deliveryId, leaseToken: claim.leaseToken, status: 'SENDING'
      }).update({ data: {
        status: retryable ? 'RETRYABLE' : 'PERMANENT_FAILED',
        errorCode: retryable ? 'SEND_FAILED' : 'WEBHOOK_REJECTED',
        nextRetryAt: retryable ? new Date(Date.now() + 60000).toISOString() : '',
        leaseToken: ''
      } });
      return {
        groupId: group._id, status: retryable ? 'RETRYABLE' : 'PERMANENT_FAILED',
        webhookFingerprint: fingerprint, errorCode: retryable ? 'SEND_FAILED' : 'WEBHOOK_REJECTED',
        ...route, retryable
      };
    }
  }));

  const status = !groups.length
    ? 'FAILED'
    : deliveries.length > 0 && deliveries.every(item => item.status === 'ACCEPTED')
      ? 'SENT'
      : deliveries.some(item => item.status === 'ACCEPTED') ? 'PARTIAL' : 'FAILED';
  const retryable = !groups.length || deliveries.some(item => item.retryable);
  const eventStatus = !retryable && status !== 'SENT' ? 'PERMANENT_FAILED' : status;
  try {
    await db.collection('notification_events').where({ eventId }).update({ data: {
      status: eventStatus,
      updatedAt: new Date().toISOString(),
      retryCount: status === 'FAILED' || status === 'PARTIAL' ? 1 : 0,
      nextRetryAt: retryable ? new Date(Date.now() + 60000).toISOString() : ''
    } });
  } catch (error) { /* 事件可能尚未由业务动作创建 */ }
  return {
    success: status === 'SENT', status: eventStatus, retryable,
    code: groups.length ? undefined : (operator.isTest ? 'NO_TEST_GROUP_CONFIGURED' : 'NO_GROUP_CONFIGURED'),
    deliveries
  };
}

async function notifyGroup(db, type, order, operator, send = postWebhook, suppliedUsers) {
  return { success: true, status: 'SUPPRESSED', sent: 0, msg: '旧员工Webhook通知路径已停用' };
  /* legacy employee-webhook implementation retained for data compatibility */
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

module.exports = { notifyGroup, notifyConfiguredGroups, parseWebhook, postWebhook, recipients, webhookFingerprint, normalizeGroup };
