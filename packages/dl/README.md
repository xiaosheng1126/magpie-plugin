# magpie-dl

Magpie/OpenCode provider plugin for **Directionally Local (dl)**。复用 `dl` CLI 登录态，并按 dl 官方 CLI 的请求格式访问免费模型。

## 安装

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#dl
```

或从本地路径安装（调试用）：

```sh
magpie plugin add /Users/huangdongsheng/Projects/magpie-dl
```

## 特性

- 复用 `dl` CLI 登录态（首次授权导入）。
- 每个 Magpie 账号使用自己的 OAuth 登录态，不串用 CLI 当前 token。
- 请求失败不自动重试。429、5xx、401 原样交给 Magpie。
- 每个账号 `maxConcurrency: 1`，不硬编码 RPM。
- 额度只显示 GPT-6 与 DEEPSEEK 两项。
- 不输出 token，错误脱敏。
- 聊天请求体与官方 CLI 对齐；未知模型能力默认关闭。

## 目录

```text
index.mjs              # 导出 DlPlugin
opencode.mjs           # Magpie/OpenCode 1.x 入口（package.json main）
opencode2.mjs          # OpenCode 2.x 桥接（package.json exports["."]）
plugins/dl/index.mjs
shared/core.mjs
```

## 验证

```sh
npm run check
npm test
```
