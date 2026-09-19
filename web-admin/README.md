# Web Admin（PC 客服后台）

这是现有微信小程序工单系统的 PC Web 前端。它与小程序共用同一个 CloudBase 环境、`users`、`orders`、`payment_transactions` ；Web 通过独立的 `manageOrderWeb` 云函数访问同一套业务数据。

## 第一阶段已实现

- Web 登录
- 工单列表、搜索、状态/城市筛选
- 新录单
  - 客户电话
  - 服务城市与地址
  - 预约上门时间
  - 8 个快捷时间：今天/明天 × 早上/上午/下午/晚上
  - 自然语言时间自由输入，例如“9月9日中午12点到1点上门”
  - 订单来源
  - 初始回馈备注
  - **没有客户姓名字段**
  - **客服录单不提供派单功能**
- 工单详情
- 客服/主管改期、回馈、催单
- 客服取消工单
- 仅主管显示派单/改派功能

## 身份设计

Web 使用 CloudBase 自带身份认证，不自行保存密码。

1. 在 CloudBase 控制台开启“用户名密码登录”。
2. 为需要使用 PC 后台的 `admin / leader / service` 创建 Web 登录账号。
3. CloudBase 身份认证账号必须绑定/验证与员工 `users.phone` 一致的手机号。
4. 第一次登录后，前端把员工手机号作为绑定目标提交；`manageOrderWeb` 会通过 CloudBase Auth 反查 `PHONE` 登录标识，确认当前 UID 确实拥有该手机号后，才把 UID 写入 `users.webUid`。
5. CloudBase 独立 `username` 不要求等于手机号；员工身份最终由 `webUid` 识别。
6. 前端不能提交 `webUid` 或员工角色来冒充身份。
7. 第一阶段不开放 `worker` 角色使用 Web 后台。

## 环境配置

复制：

```bash
cp .env.example .env.local
```

环境 ID 已按当前小程序填写：

```text
cloud1-2g9qjh1nf5e56557
```

如控制台要求 Web Publishable Key，再填写：

```text
VITE_CLOUDBASE_ACCESS_KEY=...
```

Publishable Key 可以用于浏览器；不要把 SecretId / SecretKey 写进 Web 项目。

## 本地启动

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

输出目录：`web-admin/dist/`，可以部署到 CloudBase 静态网站托管。

## 后端部署

Web 已使用独立云函数：

```text
cloudfunctions/manageOrderWeb/
```

Web 开发只部署 `manageOrderWeb`。不要因为 Web 改动重新部署正在使用的小程序 `manageOrder`。

## 权限

- `service`：录单、查看有权限城市订单、改期、回馈、催单、客服取消；**无派单权限**。
- `leader`：录单、查看有权限城市订单、改期、回馈、催单、派单/改派。
- `admin`：查看所有订单；第一阶段不通过录单页面录单，也不通过普通派单接口派单。
