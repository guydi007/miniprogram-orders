const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RETENTION_MS = 72 * 60 * 60 * 1000;
const EXPECTED_TRIGGER = 'orphanUploadCleanupHourly';

function orderReferencesFile(order, fileID) {
  if (!order || !fileID) return false;
  if (Array.isArray(order.finishPhotos) && order.finishPhotos.includes(fileID)) return true;
  if (Array.isArray(order.feedbacks) && order.feedbacks.some(item => {
    const photos = item && (item.photos || item.images);
    return Array.isArray(photos) && photos.includes(fileID);
  })) return true;
  if (Array.isArray(order.paymentLogs) && order.paymentLogs.some(item => Array.isArray(item && item.photos) && item.photos.includes(fileID))) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function registryPathMatches(record) {
  const fileID = String(record && record.fileID || '').trim();
  const orderId = String(record && record.orderId || '').trim();
  const operationId = String(record && record.operationId || '').trim();
  const kind = String(record && record.kind || '').trim();
  if (!fileID || !orderId || !operationId || !['payment', 'feedback'].includes(kind)) return false;
  const segment = kind === 'payment' ? 'payments' : 'feedback';
  const pattern = new RegExp(`/orders/${escapeRegExp(orderId)}/${segment}/${escapeRegExp(operationId)}/[^/]+$`);
  return pattern.test(fileID);
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const triggerName = String(event.TriggerName || '');
  // 清理函数只允许配置的定时触发器调用；小程序客户端或其他来源不能主动触发扫描/删除。
  if (wxContext.OPENID || triggerName !== EXPECTED_TRIGGER) {
    return { success: false, code: 'SYSTEM_TRIGGER_REQUIRED', msg: '仅允许系统定时任务执行图片清理' };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // 双重保护：即使 cleanupAfter 被误写得过早，也必须 uploadedAt 已经超过 72 小时才允许删除。
  const hardCutoffMs = nowMs - RETENTION_MS;
  const result = await db.collection('upload_registry').where({
    cleanupAfter: _.lte(now)
  }).limit(50).get().catch(error => {
    console.error('读取上传登记失败：', error.message);
    return { data: [] };
  });

  const output = [];
  for (const record of (result.data || [])) {
    const uploadedMs = Date.parse(record.uploadedAt || '');
    if (!Number.isFinite(uploadedMs) || uploadedMs > hardCutoffMs) continue;

    const fileID = String(record.fileID || '').trim();
    if (!fileID) {
      await db.collection('upload_registry').doc(record._id).remove().catch(() => null);
      continue;
    }

    // 登记数据本身如果与规定的工单/operation 路径不一致，只丢弃登记，绝不删除文件。
    if (!registryPathMatches(record)) {
      await db.collection('upload_registry').doc(record._id).remove().catch(() => null);
      output.push({ fileID, status: 'INVALID_REGISTRY_SKIPPED' });
      continue;
    }

    const orderResult = await db.collection('orders').doc(record.orderId).get().catch(() => ({ data: null }));
    if (orderReferencesFile(orderResult.data, fileID)) {
      // 已被正式业务数据引用：只删除临时登记，绝不删除文件。
      await db.collection('upload_registry').doc(record._id).remove().catch(() => null);
      output.push({ fileID, status: 'REFERENCED' });
      continue;
    }

    try {
      await cloud.deleteFile({ fileList: [fileID] });
      await db.collection('upload_registry').doc(record._id).remove().catch(() => null);
      output.push({ fileID, status: 'DELETED' });
    } catch (error) {
      await db.collection('upload_registry').doc(record._id).update({ data: {
        lastCleanupAt: now,
        lastCleanupError: String(error.message || error).slice(0, 300),
        cleanupAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      } }).catch(() => null);
      output.push({ fileID, status: 'RETRY' });
    }
  }

  return { success: true, thresholdHours: 72, processed: output.length, results: output };
};
