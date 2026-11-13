# 企业微信群通知：交付说明

对应 `IMPLEMENTATION_HANDOVER.md` 第 16 节。本说明只记录代码审计结果，未部署、未运行测试、未向任何群发送消息。

## 1. 修改文件
| 文件 | 说明 |
|---|---|
| `cloudfunctions/manageOrder/index.js`、`manageOrderWeb/index.js` | 收款快照新增 `settlementNote`；新建群时校验城市在启用的 `cities` 中 |
| `cloudfunctions/*/groupNotifications.js` | 收款消息反馈取结算备注；文本按 Unicode 字符截断并去控制字符；删除旧员工 Webhook 代码 |
| `cloudfunctions/*/notifications.js` | 个人订阅通知旧代码删除，仅保留 `getNotificationConfig` 空实现 |
| `miniprogram/pages/create`、`detail`、`index` | 移除已停用的师傅群号读写与展示 |

`manageOrder` 与 `manageOrderWeb` 的通知代码是两份拷贝，修改必须同步。

## 2. 群管理动作（均校验 admin）
`getNotificationGroups`、`createNotificationGroup`、`updateNotificationGroup`、`deleteNotificationGroup`（软删除）、`retryNotificationEvents`。响应只含脱敏尾号，不含 `webhookUrl`。

## 3. 幂等与事务
- 收款：`operationId` + `payment_transactions` 查重；订单、支付流水、通知事件在同一数据库事务内写入，并带订单版本校验。
- 群投递：以 `eventId + groupId + webhookFingerprint` 生成确定性文档 ID，事务内抢占发送权。
- 外部 Webhook 仍可能出现“请求已到达但响应超时”，不能保证严格恰好一次。

## 4. 待验证（均未完成）
- [ ] 云函数部署；CloudBase 事务在目标环境可用
- [ ] 为 `retryNotificationEvents` 配置定时触发器（建议每分钟）
- [ ] 测试账号 + 虚构订单 + 测试群端到端：新订单、全款、预约款、续款、尾款、金额修正、现场未成、客服取消
- [ ] 测试/正式群隔离、跨城不误发、同 Webhook 只发一次
- [ ] 日志无完整电话、Webhook、OpenID
- [ ] 真机检查结算弹窗与群管理页
- [ ] 手册第 15 节验收清单逐项勾选

## 5. 待业务决策
已收预约款的订单可被取消或标为未成单，代码不会清零或退款，也无核销流程。需业务负责人确认退款、挂账或转单规则。

## 6. 发布
不执行体验版/正式版发布，由项目负责人处理。
