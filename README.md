# opencode-intern-tokenplan-auth

书生·端砚（Intern InkStone）TokenPlan 的模型，作为 magpie / OpenCode 的 provider 插件。

装上之后，任何 agent 都能直接选 `intern/deepseek-v4.1-flash-1017` 这样的模型，
走端砚的免费额度。

## 它是什么

上海人工智能实验室（Intern / OpenXLab）的科研模型平台，提供：

- **每月免费 10000 墨点**（约合 1000 万 tokens 的 DeepSeek-V4.1-Flash 输入）
- **OpenAI / Anthropic 双协议**兼容端点
- **多账号**：每个账号独立额度，插件按账号分别显示

## 模型

价格单位：**墨点 / 百万 tokens**（2026-11-14 实测，来自 `/api/tokenplan/v1/public/models`）

| id | 上下文 | 输入（缓存命中） | 输入（未命中） | 输出 | 推理 | 工具 | 图片 |
|---|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash-1017` | 1M | 20 | 1,000 | 4,000 | ✓ | ✓ | ✓ |
| `glm-5.3` | 1M | 2,000 | 8,000 | 28,000 | ✓ | ✓ | |
| `kimi-k3.1-pro` | 1M | — | 13,000 | 68,000 | ✓ | ✓ | ✓ |
| `qwen3.8-27b` | 256K | 100 | 800 | 2,700 | ✓ | ✓ | ✓ |
| `intern-s2` | 256K | 6 | 30 | 180 | | ✓ | ✓ |
| `Agents-A1` | 256K | 3.2 | 16 | 64 | | ✓ | ✓ |
| `Sage-A1.5` | 512K | 3.2 | 16 | 64 | | ✓ | ✓ |
| `Sage-A1.5-Taiyi` | 512K | 6.4 | 32 | 128 | | ✓ | |
| `Atria-Dawn` | 512K | 20 | 80 | 280 | | | |

`intern-decision-4b` 未收录：它只在 SystemOne 端点应答，不是 chat 协议。

`Atria-Dawn-Preview` 上游可调用，但平台没有公布它的价格，所以插件不暴露它——
避免出现「用了但不知道花多少墨点」的情况。

## 实测验证（2026-11-14）

用真实账号跑通：

| 项 | 结果 |
|---|---|
| `config()` 注册 provider | ✅ 9 个模型，OpenAI / Anthropic 双协议 |
| `provider.models()` 真实 key | ✅ 返回 9 个（上游 10 个，`Atria-Dawn-Preview` 无价格被过滤） |
| 非流式 chat | ✅ 200，`content: "好的，已收到。"`，usage 正常 |
| 流式 chat | ✅ 200，`text/event-stream`，36 个 chunk，含 `[DONE]` |
| 工具调用 | ✅ 返回 `tool_calls`，参数 `{"city": "北京"}` |
| Anthropic `/v1/messages` | ✅ 200，thinking + text 块 |
| `auth.usage()` 真实 uaa-token | ✅ 3 个窗口，数字与网页一致 |
| 过期 uaa-token | ✅ 标记 `X-Magpie-Sign-In: expired` |
| 无效 API Key | ✅ 401 + 明确中文错误 |
| uaa-token 自动开通 API Key | ✅ 200，返回明文 `sk-...`，该 key 可调 `/v1/models` |
| 多账号导入解析 | ✅ 覆盖 `name\|sk-\|uaa`、JSON 对象/数组 |

自检脚本：`node test.mjs`（离线 41 项）；设 `INTERN_UAA` 后追加联网额度测试。

平台不公布 max-output，所以 `limit.output` 取上下文长度。

## 安装

```sh
magpie plugin add github:xiaosheng1126/magpie-plugin#intern
magpie plugin update
magpie plugin login intern
```

## 登录：只粘 uaa-token 就够

推理和查额度原本是两套凭据（`sk-...` 付推理、`uaa-token` 查额度），但手动去控制台
建 key 是多余的一步：**只要有 uaa-token，插件会替你开通一把本机的 API Key 并缓存起来。**

`magpie plugin login intern` 选第一个方法，粘 uaa-token 即可：

- 插件先 `GET /api/tokenplan/v1/users/validate` 校验登录态，顺手拿到账号名（微信名 / 手机 / 邮箱）
- 再 `POST /api/tokenplan/v1/keys` 建一把名为 `magpie-<主机名>` 的 key（重名自动 `-2`、`-3`）
- **明文只在创建时返回一次**，所以立刻写进 `~/.config/magpie/cache/intern-keys.json`（`0600`，
  按 uaa-token 的 sha256 指纹索引）。同一个 uaa-token 再登录直接复用，不会在控制台堆 key

第二种方法仍然保留：填 `<API Key>|<uaa-token>`，或用 JSON `{"key":"sk-...","uaa":"eyJ..."}`。
适合「key 已经在控制台建好、明文也存着」的情况。**只填 API Key 也能推理**，只是额度卡片读不到数字。

代价：uaa-token 约 14 天过期，过期后额度卡片会标 `X-Magpie-Sign-In: expired`，
重新登录一次即可（缓存里的 key 还能继续推理）。

### 怎么拿 uaa-token

**方法一：脚本自动取**（需要本机装了 ego-browser 并登录过该站）

```sh
./tools/get-token.sh                 # 自动从 magpie 找 key，输出 sk-...|eyJ...
./tools/get-token.sh sk-xxxxxxxx     # 指定 key
./tools/get-token.sh --token-only    # 只打印 uaa-token
```

脚本会从 `~/.config/magpie/providers.json` 里找 `chat` 指向
`discovery-api.intern-ai.org.cn` 的 provider，取它的 key，再拼上 ego-browser
登录态里的 `uaa-token`。输出直接粘给 `magpie plugin login intern` 即可。

**方法二：DevTools 手动复制**

1. 浏览器登录 https://discovery.intern-ai.org.cn
2. DevTools → Application → Cookies → **`.openxlab.org.cn`**（不是 `discovery.intern-ai.org.cn`）
3. 复制 `uaa-token` 的值（约 293 字符的 JWT）

> 实测确认：`uaa-token` 挂在 `.openxlab.org.cn` 域下，`discovery.intern-ai.org.cn`
> 域下只有 `acw_tc` 等无关 cookie。

`uaa-token` 有效期约 14 天，过期后重新登录一次即可。

### 为什么 API Key 读不到额度

实测四种 header 写法全部 401：

```
Authorization: Bearer sk-...   -> 401 {"msgCode":"A0211","msg":"user token expired"}
X-API-Key: sk-...              -> 401 同上
api-key: sk-...                -> 401 {"code":-10002,"msg":"参数错误，请求未认证"}
Authorization: sk-...          -> 401 同上
```

额度接口 `/api/tokenplan/v1/credits/balance` 只认**用户登录态**（uaa-token），
不认 API Key。API Key 只用于 `/v1/chat/completions` 推理。

所以：**推理只用 key 就行，额度必须额外给 uaa-token**。

## 多账号

两个办法：

**逐个登录**：再执行一次 `magpie plugin login intern`。magpie 把第一个存为 `intern`，
后续的存为 `intern#xxxxxx`，并对每个账号分别调用 `auth.usage`，每个账号有自己的卡片和数字。

**一次导入**（magpie 登录界面选「Import accounts from a file…」）：每行一个账号，

```
zygu1g|sk-xxxxxxxx|eyJ0eXBlIjoiSldU...
sk-yyyyyyyy|eyJ0eXBlIjoiSldU...
eyJ0eXBlIjoiSldU...
```

第三行只有 uaa-token，插件会自动开通 key。也接受 JSON 数组：

```json
[{"name":"zygu1g","key":"sk-...","uaa":"eyJ..."},{"name":"other","uaa":"eyJ..."}]
```

账号名留空时取平台返回的微信名 / 手机 / 邮箱，保证两个账号不会撞名。

三个账号 = 每月 30000 墨点，但**都得在清零前用掉**（见下）。

## 额度显示

插件读三个数，分别代表不同东西：

| 卡片 | 含义 | 性质 |
|---|---|---|
| 5 小时窗口 | 滚动 5 小时的用量上限 | 限速，不是额度 |
| 7 天窗口 | 滚动 7 天的用量上限 | 限速，不是额度 |
| 月度免费包 | 本月真实可用墨点 | **真实额度** |

实测数据（2026-11-14）：

```
5 小时窗口   10,000 墨点上限
7 天窗口     50,000 墨点上限
月度免费包   10,000 墨点，每月 5 号 00:00 重置
```

5 小时窗口的上限恰好等于整月额度，7 天窗口反而更大——**限速窗口不是瓶颈，
月度包才是**。

## 重要：额度每月清零，不累积

交易流水实测：

```
2026-10-04 10:03:59  平台发放      +10,000.000   每月免费基础包
2026-11-05 00:00:00  墨点到期清零   -9,859.860   墨点到期清零
2026-11-05 00:00:00  平台发放      +10,000.000   每月免费基础包
```

**每月 5 号 00:00 结算，上月未用完的墨点直接清零。** 10 月剩的 9859.86 墨点
在 11 月 5 号全部作废。

所以额度不是资产，是当月消耗品——月底前用掉，否则白扔。

## 提额

平台支持申请提额，**绑定手机是硬性前置条件**：

> 申请增加配额前，请补充手机号
> 补充手机号，每月免费获取最高价值 5 亿 Tokens 额度

提额表单：

| 字段 | 规则 |
|---|---|
| 申请额度 | 1 ~ 999999 墨点 |
| 使用场景分类 | 必选，4 大类（科学研究 / 应用开发 / 课程及作业 / 其他） |
| 细分场景 | 必选，共 25 项 |
| 提额申请说明 | 选填，写详细成功率更高 |
| 审核时长 | 预计 1 个工作日 |

**提额是每月生效还是一次性，平台没有暴露这个信息**——申请表单没有周期选项，
申请记录接口也没有周期字段。审批通过后看「我的墨点包」的「额度恢复周期」列
显示「月」还是「一次性」才知道。

插件读的是 `cycle_type` 字段，两种都能正确显示，不用改代码。

## 协议要点

- OpenAI 端点：`https://discovery-api.intern-ai.org.cn/v1`
- Anthropic 端点：`https://discovery-api.intern-ai.org.cn`
- Key 管理接口：`/api/tokenplan/v1/keys` —— **只认 Cookie `uaa-token=`**，Bearer 会返回
  `{"code":-10002,"msg":"request is not authenticated"}`
- 额度接口：`https://discovery.intern-ai.org.cn/api/tokenplan/v1/*`
- 额度接口的 `Authorization: Bearer <uaa-token>` 是必需的——**只带 cookie 会 401**
- 额度接口失败有两种形状：`msgCode: "A0211"`（token 过期）和 `code: -10002`（未认证），
  插件都识别为「登录失效」并打 `X-Magpie-Sign-In: expired` 标记，magpie 可据此 failover

## 限制

- 没有 OAuth 回调流程（SSO 回跳落在纯前端 SPA，兑换参数未公开），只能手动粘 `uaa-token`
- `uaa-token` 约 14 天过期，需要重新登录
- 平台不公布 max-output，`limit.output` 用上下文长度代替
- 墨点没有 USD 汇率，所以 `cost` 恒为 0，额度只走 `auth.usage`
- 月度额度月底清零，不累积

## 非官方

逆向实现，与上海人工智能实验室 / OpenXLab 官方无关。
使用前请自行确认是否符合服务条款。
