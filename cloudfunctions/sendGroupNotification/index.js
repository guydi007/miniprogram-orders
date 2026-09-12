// 群提醒已收口到 manageOrder 的云端业务流程，不再接受客户端指定收件人和内容。
exports.main = async () => ({
  success: false,
  msg: '该直接推送入口已停用，请通过录单或催单操作触发通知'
});
