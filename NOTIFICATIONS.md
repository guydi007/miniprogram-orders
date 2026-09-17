# 订单群通知

订单通知统一使用 `notification_groups` 集合中的企业微信群机器人，不再使用员工记录里的 `groupId` 或 `webhookUrl`，也不启用个人微信订阅消息。

## 路由

- `NEW_ORDER` → 订单城市的 `order_entry` 入单群
- `FULL_PAYMENT`、`DEPOSIT_PAYMENT`、`ADDITIONAL_PAYMENT`、`FINAL_PAYMENT`、`AMOUNT_CORRECTION` → `deal` 成单群
- `ONSITE_FAILED`、`SERVICE_CANCELLED` → `unconverted` 未成单群
- `urgent` 只更新小程序内催单状态，不发送群消息

通知只匹配相同城市和相同测试标识的启用群；多个群全部发送，相同 Webhook 只发送一次。手机号会脱敏，Webhook 只保存指纹用于去重，前端只返回脱敏尾号。

## 重试

失败事件记录在 `notification_events`，投递记录在 `notification_deliveries`。重试动作是 `manageOrder` 的 `retryNotificationEvents`，间隔为 1 分钟、5 分钟、30 分钟，最多 3 次。云开发定时器需要在控制台配置调用该动作。

## 数据兼容

历史员工和订单中的群字段不删除，只停止使用；群配置字段按 `notification_groups` 规范兼容读取。支付历史继续保留订单内 `paymentLogs`，同时由云端写入 `payment_transactions`。
