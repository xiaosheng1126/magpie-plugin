# opencode-clixad-auth

把 **Clixad** 作为 Magpie / OpenCode provider 接入，并复用本地 `clixad` CLI 登录态。

## 安装

先在终端完成 Clixad CLI 登录：

```sh
clixad login
```

再把插件装进 Magpie：

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#clixad
magpie plugin login clixad
```

登录时选择「Clixad CLI 登录态（自动复用本地登录）」即可。也可以选择手动填入 Bearer Token。

检查模型和额度：

```sh
magpie models
magpie quota clixad
```

## 登录态

插件读取：

```text
~/.clixad/config.json
```

自动复用的关键字段：

- `token`
- `tokenGateway`
- `gatewayUrl`
- `email`
- `userId`

`token` 会绑定到 CLI 写入的 `tokenGateway`。如果 `CLIXAD_GATEWAY_URL` 指向的网关与绑定网关不一致，插件会拒绝发送 token，并提示重新运行 `clixad login`。不会把本地 token 发往另一个网关。

首版不实现插件内 GitHub Device OAuth。Clixad CLI 负责登录，插件只复用本地结果或接受手动 Bearer Token。

## 模型与额度

插件动态读取：

```text
GET /v1/models
GET /v1/wallet?premium=1
```

模型列表会同步上下文窗口、免费状态、access、reasoning efforts 和 credits 信息。免费模型名称会显示 `turns_left`；额度页会显示每日免费 credits、免费回合、下个 UTC 零点重置时间、Budget credits 与 Premium credits/解锁状态。

如果模型目录读取失败或返回为空，会回退到 bootstrap 模型：

```text
gemini-2.5-flash-lite
```

## 请求行为

- 使用 `Authorization: Bearer <token>`。
- 每次请求重新读取当前登录态，并跟随当前登录态绑定的网关。
- Chat Completions 请求未指定 `stream` 时补 `stream: false`，已指定时保持原值。
- `429`、`401` 等上游响应原样返回，不自动重试。
- 网络错误会脱敏 token 后显示为 `Clixad 请求失败: ...`。
- 首版没有 `403` gzip fallback。
- 不猜测未知多模态能力；未声明的视觉能力不会写入模型 capabilities。

## 隐私边界

插件只调用模型目录、额度和 Chat Completions 所需接口。不调用签到、广告、sponsor、survey、earn、impression 等收益接口。

## 非官方

本插件是非官方逆向实现，与 Clixad 官方无关。使用前请自行确认符合服务条款。
