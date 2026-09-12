// 订阅消息由 manageOrder 根据已保存工单、可信身份和通知配置发送。
// 关闭原来允许客户端传入姓名、订单内容的任意发送入口。
exports.main = async () => ({
  success: false,
  msg: '该直接推送入口已停用，请通过录单或催单操作触发通知'
});
