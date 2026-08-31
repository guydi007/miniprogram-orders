const cloud = require('wx-server-sdk');
const https = require('https');
const url = require('url');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async (event) => {
  const { type, order, reason, opName } = event;
  const db = cloud.database();

  try {
    // 1. 根据指派的师傅姓名，从 users 表中找到该师傅绑定的专属群 Webhook
    let targetWebhookUrl = '';

    if (order.workerName) {
      const userRes = await db.collection('users').where({
        name: order.workerName,
        role: 'worker'
      }).get();

      if (userRes.data && userRes.data.length > 0) {
        targetWebhookUrl = userRes.data[0].webhookUrl || '';
      }
    }

    // 如果该师傅未配置专属群 Webhook，则安全跳过
    if (!targetWebhookUrl) {
      console.log(`师傅【${order.workerName}】尚未配置专属群 Webhook，跳过群推送`);
      return { success: false, msg: '未配置专属群机器人' };
    }

    // 2. 组装消息卡片
    let postData = {};

    if (type === 'urge') {
      // 催单高亮卡片
      const markdownText = [
        `### <font color="warning">🔥【客户紧急催单提醒】</font>`,
        `> **师傅**：<font color="comment">${order.workerName}</font>`,
        `> **预约时间**：${order.appointmentTime}`,
        `> **客户电话**：${order.customerPhone}`,
        `> **服务地址**：${order.address}`,
        `> **催单说明**：<font color="warning">${reason || '客户催促尽快上门'}</font>`,
        `> **发起客服**：${opName || '客服'}`,
        `\n请师傅立即联系客户并加急前往处理！`
      ].join('\n');

      postData = {
        msgtype: 'markdown',
        markdown: { content: markdownText },
        mentioned_mobile_list: order.workerPhone ? [order.workerPhone] : ['@all']
      };
    } else if (type === 'assign') {
      // 派单通知卡片
      const markdownText = [
        `### <font color="info">📋【新工单指派通知】</font>`,
        `> **师傅**：<font color="comment">${order.workerName}</font>`,
        `> **预约时间**：${order.appointmentTime}`,
        `> **客户电话**：${order.customerPhone}`,
        `> **服务地址**：${order.address}`,
        `> **订单来源**：${order.source}`,
        `> **初始备注**：${order.remark || '无'}`,
        `\n请师傅及时查看并提前与客户确认。`
      ].join('\n');

      postData = {
        msgtype: 'markdown',
        markdown: { content: markdownText },
        mentioned_mobile_list: order.workerPhone ? [order.workerPhone] : ['@all']
      };
    }

    // 3. 发送 HTTP POST 请求给该师傅的专属群
    const payload = JSON.stringify(postData);
    const parsedUrl = url.parse(targetWebhookUrl);

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ success: true, res: JSON.parse(data) });
          } catch (e) {
            resolve({ success: true, res: data });
          }
        });
      });

      req.on('error', (err) => {
        reject({ success: false, error: err });
      });

      req.write(payload);
      req.end();
    });

  } catch (err) {
    console.error('群推送执行异常：', err);
    return { success: false, error: err };
  }
};