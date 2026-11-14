// 插件自检。离线部分随时可跑；联网部分需要 INTERN_UAA 环境变量。
//
//   node test.mjs
//   INTERN_UAA='eyJ0eXBlIjoiSldU...' node test.mjs
//
// INTERN_UAA 是浏览器 cookie 里 `.openxlab.org.cn` 域下的 uaa-token。

import plugin, { _internal } from "./index.mjs";

const uaa = String(process.env.INTERN_UAA ?? "").trim();

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("parseCred");
{
  const cases = [
    ["sk-abc|eyJxyz", "sk-abc", "eyJxyz"],
    ["eyJxyz|sk-abc", "sk-abc", "eyJxyz"],
    ['{"key":"sk-abc","uaa":"eyJxyz"}', "sk-abc", "eyJxyz"],
    ["sk-only", "sk-only", ""],
    ["eyJ-only", "", "eyJ-only"],
    ["", "", ""],
  ];
  for (const [input, ek, eu] of cases) {
    const r = _internal.parseCred(input);
    check(JSON.stringify(input), r.key === ek && r.uaa === eu, JSON.stringify(r));
  }
}

console.log("accountsIn");
{
  const one = _internal.accountsIn("zygu1g|sk-abc|eyJxyz")[0];
  check("name|key|uaa", one?.name === "zygu1g" && one?.key === "sk-abc" && one?.uaa === "eyJxyz", JSON.stringify(one));
  const bare = _internal.accountsIn("sk-abc|eyJxyz")[0];
  check("key|uaa", bare?.name === "" && bare?.key === "sk-abc" && bare?.uaa === "eyJxyz", JSON.stringify(bare));
  const multi = _internal.accountsIn("a|sk-1|eyJ1\nb|sk-2|eyJ2");
  check("两行两个账号", multi.length === 2 && multi[1].name === "b", JSON.stringify(multi));
  const json = _internal.accountsIn('[{"name":"a","key":"sk-1","uaa":"eyJ1"},{"account":"b","apiKey":"sk-2","token":"eyJ2"}]');
  check("JSON 数组", json.length === 2 && json[1].name === "b" && json[1].uaa === "eyJ2", JSON.stringify(json));
  const obj = _internal.accountsIn('{"key":"sk-1","uaa":"eyJ1"}');
  check("JSON 单对象", obj.length === 1 && obj[0].key === "sk-1", JSON.stringify(obj));
  check("空文本返回空", _internal.accountsIn("  ").length === 0);
}

console.log("nameOf");
{
  check("wechatName 优先", _internal.nameOf({ wechatName: "微信名", phone: "138" }) === "微信名");
  check("phone 次之", _internal.nameOf({ phone: "138", ssoUid: "u1" }) === "138");
  check("username/email/ssoUid 兜底", _internal.nameOf({ email: "a@b.c" }) === "a@b.c");
  check("全空返回 intern", _internal.nameOf({}) === "intern");
}

console.log("fpOf");
{
  const a = _internal.fpOf("eyJxyz");
  check("16 位 hex", /^[0-9a-f]{16}$/.test(a), a);
  check("同 token 同指纹", _internal.fpOf("eyJxyz") === a);
  check("不同 token 不同指纹", _internal.fpOf("eyJxyq") !== a);
  check("未知 token 无缓存 key", _internal.cachedKey("eyJ-never-signed-in") === "");
}

console.log("isoOf");
{
  check("北京时间转 ISO", _internal.isoOf("2026-12-05 00:00:00") === "2026-12-05T00:00:00+08:00");
  check("非法输入返回 undefined", _internal.isoOf("nope") === undefined);
}

console.log("config()");
{
  const p = await plugin({}, {});
  const cfg = {};
  await p.config(cfg);
  const prov = cfg.provider?.intern;
  check("provider 存在", !!prov);
  check("name", prov?.name === "Intern TokenPlan", prov?.name);
  check("npm 是 openai-compatible", prov?.npm === "@ai-sdk/openai-compatible", prov?.npm);
  check("api 指向 discovery-api", prov?.api === "https://discovery-api.intern-ai.org.cn/v1", prov?.api);
  const ids = Object.keys(prov?.models ?? {});
  check(`模型数 ${ids.length}`, ids.length === 9, ids.join(","));
  const m = prov?.models?.["deepseek-v4.1-flash-1017"];
  check("free=false（有价格）", m?.free === false);
  check("cost 全 0（墨点无汇率）", m?.cost?.input === 0 && m?.cost?.output === 0);
  check("context 1M", m?.limit?.context === 1048576, String(m?.limit?.context));
  check("capabilities.toolcall", m?.capabilities?.toolcall === true);
}

console.log("config() anthropic 协议");
{
  const p = await plugin({}, { api: "anthropic" });
  const cfg = {};
  await p.config(cfg);
  const prov = cfg.provider?.intern;
  check("npm 是 anthropic", prov?.npm === "@ai-sdk/anthropic", prov?.npm);
  check("模型数 9", Object.keys(prov?.models ?? {}).length === 9);
}

console.log("provider.models() 回退");
{
  const p = await plugin({}, {});
  const cfg = {};
  await p.config(cfg);
  const noAuth = await p.provider.models(cfg.provider.intern, {});
  check("无凭据回退静态列表", Object.keys(noAuth).length === 9);
  const badKey = await p.provider.models(cfg.provider.intern, { auth: { key: "sk-fake" } });
  check("列表失败仍回退静态列表", Object.keys(badKey).length === 9);
}

console.log("auth.usage() 无 uaa");
{
  const p = await plugin({}, {});
  const res = await p.auth.usage(async () => ({ type: "api", key: "sk-only" }));
  check("返回明确错误", /uaa-token/.test(res.error ?? ""), res.error);
  check("windows 为空", res.windows?.length === 0);
}

console.log("auth.loader()");
{
  const p = await plugin({}, {});
  const l = await p.auth.loader(async () => ({ type: "api", key: "sk-abc|eyJxyz" }));
  check("baseURL", l.baseURL === "https://discovery-api.intern-ai.org.cn/v1", l.baseURL);
  check("apiKey 是 sk 部分", l.apiKey === "sk-abc", l.apiKey);
  check("有 fetch", typeof l.fetch === "function");
  const empty = await p.auth.loader(async () => ({ type: "api", key: "" }));
  check("无凭据返回空对象", Object.keys(empty).length === 0);
}

if (!uaa) {
  console.log("\n跳过联网测试（未设置 INTERN_UAA）");
} else {
  console.log("auth.usage() 真实 uaa-token");
  {
    const p = await plugin({}, {});
    const res = await p.auth.usage(async () => ({ type: "api", key: `sk-fake|${uaa}` }));
    check("无 error", !res.error, res.error);
    check("有 user", !!res.user, res.user);
    check("3 个窗口", res.windows?.length === 3, String(res.windows?.length));
    const names = (res.windows ?? []).map((w) => w.name);
    check("含 5 小时窗口", names.includes("5 小时窗口"), names.join(","));
    check("含 7 天窗口", names.includes("7 天窗口"), names.join(","));
    check("含 月度免费包", names.includes("月度免费包"), names.join(","));
    const pkg = (res.windows ?? []).find((w) => w.name === "月度免费包");
    check("月度包 display 有墨点", /墨点/.test(pkg?.display ?? ""), pkg?.display);
    check("月度包 resetsAt 是 ISO", /^\d{4}-\d{2}-\d{2}T/.test(pkg?.resetsAt ?? ""), pkg?.resetsAt);
    check("plan 含 墨点/月", /墨点\/月/.test(res.plan ?? ""), res.plan);
  }

  console.log("auth.usage() 过期 uaa");
  {
    const p = await plugin({}, {});
    const res = await p.auth.usage(async () => ({
      type: "api",
      key: "sk-x|eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.bad",
    }));
    check("标记 signIn=expired", res.signIn === "expired", JSON.stringify(res));
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
