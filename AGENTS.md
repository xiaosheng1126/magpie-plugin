# magpie-plugin

四个 magpie / OpenCode provider 插件的合居仓库。**合居只是为了少几个仓库，四个插件之间没有任何依赖。**

## 目录约定

```
packages/<name>/        一个完整的、可单独发布的插件包
  package.json          name 必须唯一（magpie 用它在 node_modules 里建目录）
  index.mjs             插件入口（或 package.json 的 main 指定）
  README.md             这个插件自己的说明、登录方式、已知坑
  test*.mjs             离线自检
tools/publish.sh        把 packages/<name> 拆成同名分支推上去
```

- **禁止跨包 import**：`packages/dl` 不许引 `packages/intern` 的任何东西。共享代码就复制，或提到各自的 `shared/`。
- **每个包自包含**：把 `packages/<name>/` 单独拷走，得能直接 `magpie plugin add` 用。
- 新增插件 = 新建 `packages/<name>/` + 在 README 的安装表加一行。

## 发布

`main` 只是开发分支，**magpie 装的是每个包对应的同名分支**：

| 包 | 安装 spec |
|---|---|
| `packages/dl` | `github:xiaosheng1126/magpie-plugin#dl` |
| `packages/apinex` | `github:xiaosheng1126/magpie-plugin#apinex` |
| `packages/freepi` | `github:xiaosheng1126/magpie-plugin#freepi` |
| `packages/intern` | `github:xiaosheng1126/magpie-plugin#intern` |

改完代码必须推分支，否则用户装到的还是老的：

```sh
./tools/publish.sh            # 四个都推
./tools/publish.sh intern     # 只推一个
```

需要 `main` 已 commit：`publish.sh` 从 `main` 的 `packages/<name>` 子树快照出分支。

## 验证

改哪个包就验哪个，不用跑重型构建：

```sh
node --check packages/<name>/index.mjs
node --test packages/dl/            # dl / apinex：node --test
node packages/intern/test.mjs       # intern / freepi：自带脚本
```

## 纪律

- 一次提交只动一个包（跨包改动就拆成多次提交）。
- 密钥、token、cookie 不进代码、不进 commit、不进日志。
- 发布（push 分支）前确认 `main` 上的改动已提交且验证通过。
