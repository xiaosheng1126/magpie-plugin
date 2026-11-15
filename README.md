# opencode-howtofix-auth

把 **HowToFix CLI** 的 Grok 模型接入 Magpie / OpenCode，并复用本机 `howtofix` CLI 登录态。

当前固定暴露 6 个已实测可用的 Grok 模型：

- `grok-4.7`
- `grok-4.6`
- `grok-4.5`
- `grok-4.7-liberated-sg`
- `grok-4.6-liberated-sg`
- `grok-4.5-liberated-sg`

## 安装

先在终端运行 HowToFix CLI，并执行 `/connect` 完成登录：

```sh
howtofix
```

然后在 HowToFix 交互界面中执行：

```text
/connect
```

确认登录后安装并登录插件：

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#howtofix
magpie plugin login howtofix
magpie models
```

登录时选择「HowToFix CLI 登录态（自动复用本地登录）」即可。

## 登录态

插件按以下顺序读取凭据：

1. `~/.howtofix/agent/cli-credentials.json` 中尚未过期的 `accessToken`
2. `~/.howtofix/agent/auth.json` 中 `howtofix.key`
3. Magpie 已保存的登录信息

插件只读取凭据，不写入、刷新或轮换 HowToFix token，避免破坏 CLI 自己管理的登录状态。

如果 access token 已过期，或上游返回 `401`，请重新运行：

```sh
howtofix
```

然后执行：

```text
/connect
```

## 模型同步

插件调用：

```text
GET https://api.howtofix.id/v1/models
```

动态结果只保留 `grok-*` 模型，并合并本机模型元数据：

```text
~/.howtofix/agent/models.json
```

元数据用于同步：

- 上下文窗口与输出上限
- `free` / `plans` / `plan`
- reasoning 能力
- 文本与图片输入能力
- tool call 能力

如果上游模型目录失败、返回为空，或不包含 Grok，则回退到内置的 6 个 Grok 模型。

## 请求行为

- API 基址：`https://api.howtofix.id/v1`
- 使用 `Authorization: Bearer <token>`
- 使用 `X-HowToFix-Client: CLI (<本机 HowToFix 版本>)`
- 每次请求重新读取最新的本地登录态
- 原样透传 Chat Completions 请求 body，不自动增删 `stream`
- `401` 转换为可读的重新登录提示，并确保 token 不出现在响应中
- 网络错误脱敏后显示为 `HowToFix 请求失败: ...`
- `429` 等其他上游响应原样返回，不自动重试

## 已知限制

- 不实现 HowToFix OAuth 登录流程，只复用 CLI 登录态或接受手动 Token。
- 不自动刷新 access token，避免与 HowToFix CLI 争用并覆盖凭据文件。
- HowToFix 的 `/v1/models` 只用于确定 Grok 模型是否存在，不把上游 `owned_by` 当成模型能力依据。

## 非官方

本插件是非官方逆向实现，与 HowToFix 官方无关。使用前请自行确认符合服务条款。
