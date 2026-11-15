# magpie-plugin

五个 [magpie](https://github.com/yetone/magpie) / OpenCode provider 插件放在一个仓库里。

**只是住在一起**：五个包互不依赖，各自能单独安装、单独升级。合并的原因只有一个——不想开五个仓库。

## 安装

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#dl
magpie plugin add github:xiaosheng1126/magpie-plugin#apinex
magpie plugin add github:xiaosheng1126/magpie-plugin#freepi
magpie plugin add github:xiaosheng1126/magpie-plugin#intern
magpie plugin add github:xiaosheng1126/magpie-plugin#clixad
```

装完 `magpie plugin update` 拉最新，然后按各包的 README 登录。

## 包

| 分支 | 包 | 提供的 provider | 登录方式 |
|---|---|---|---|
| `dl` | `opencode-dl-auth` | `directionally-local` | 复用 `dl` CLI 登录态 |
| `apinex` | `opencode-apinex-auth` | `apinex` | 复用 `apinex` CLI 登录态 |
| `freepi` | `opencode-freepi-auth` | `free-pi` | 复用 `free-pi-cli` 登录态 |
| `intern` | `opencode-intern-tokenplan-auth` | `intern` | 粘 `uaa-token`，插件自动开通 API Key（多账号） |
| `clixad` | `opencode-clixad-auth` | `clixad` | 复用 `clixad` CLI 登录态 |

各包的细节、额度规则、已知坑都在 `packages/<name>/README.md`。

## 为什么用分支

magpie 装 GitHub 插件时读的是**仓库根**的 `package.json`，`github:owner/repo/sub` 里的 `sub` 会被忽略；bun 也不支持 `#path:`。所以每个包各自有一条分支，分支根就是那个包的全部内容。

`main` 是开发分支，分支是发布产物：

```sh
./tools/publish.sh            # 五个都推
./tools/publish.sh intern     # 只推一个
```

## 结构

```
packages/dl       Directionally Local
packages/apinex   APInex
packages/freepi   free-pi
packages/intern   Intern InkStone（书生·端砚 TokenPlan）
packages/clixad   Clixad
tools/publish.sh  子树拆分 + 推分支
AGENTS.md         目录约定与发布纪律
```

新增插件：建 `packages/<name>/`，在本表加一行，跑 `./tools/publish.sh <name>`。

## 非官方

五个插件都是逆向实现，与各自平台官方无关。使用前请自行确认符合服务条款。
