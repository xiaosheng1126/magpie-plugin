# magpie-apinex

Magpie/OpenCode provider plugin for **APInex**。复用 `apinex` CLI 登录态，并按 APInex CLI 的请求格式访问 API。

## 安装

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#apinex
```

或从本地路径安装（调试用）：

```sh
magpie plugin add /Users/huangdongsheng/Projects/magpie-apinex
```

## 特性

- 复用 `apinex` CLI 登录态（首次授权导入）。
- 每个 Magpie 账号使用自己的 OAuth 登录态，不串用 CLI 当前 token。
- 请求失败不自动重试。429、5xx、401 原样交给 Magpie。
- 每个账号 `maxConcurrency: 1`，不硬编码 RPM。
- 额度读取覆盖订阅/免费套餐与余额。
- 不输出 token，错误脱敏。
- 聊天请求体与 CLI 对齐；未知模型能力默认关闭。

## 目录

```text
index.mjs              # 导出 ApinexPlugin
opencode.mjs           # Magpie/OpenCode 1.x 入口（package.json main）
opencode2.mjs          # OpenCode 2.x 桥接（package.json exports["."]）
plugins/apinex/index.mjs
shared/core.mjs
```

## 验证

```sh
npm run check
npm test
```
