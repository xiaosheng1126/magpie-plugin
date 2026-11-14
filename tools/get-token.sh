#!/bin/sh
# 取出插件要的凭据：<API Key>|<uaa-token>
#
#   ./tools/get-token.sh                 # 自动找 key（从 magpie 的 providers.json）
#   ./tools/get-token.sh sk-xxxxxxxx     # 指定 key
#   ./tools/get-token.sh --token-only    # 只打印 uaa-token
#
# 前提：ego-browser 里已经登录过 https://discovery.intern-ai.org.cn
# 没有 ego-browser 的话，按 README「怎么拿 uaa-token」手动从 DevTools 复制。

set -e

ARG="$1"
KEY=""
TOKEN_ONLY=0

case "$ARG" in
  --token-only) TOKEN_ONLY=1 ;;
  sk-*) KEY="$ARG" ;;
  "") ;;
  *) echo "用法: $0 [sk-xxxx | --token-only]" >&2; exit 2 ;;
esac

# 没给 key 时，从 magpie 的 providers.json 里找指向端砚的那个 provider
if [ -z "$KEY" ] && [ "$TOKEN_ONLY" -eq 0 ]; then
  KEY=$(node -e '
    const fs = require("fs");
    const p = process.env.HOME + "/.config/magpie/providers.json";
    if (!fs.existsSync(p)) process.exit(0);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
    const hit = Object.values(raw.providers || {}).find(
      (v) =>
        v &&
        typeof v.key === "string" &&
        v.key.startsWith("sk-") &&
        String(v.chat || "").includes("discovery-api.intern-ai.org.cn")
    );
    if (hit) process.stdout.write(hit.key);
  ' 2>/dev/null || true)
fi

if ! command -v ego-browser >/dev/null 2>&1; then
  echo "没找到 ego-browser。手动取法见 README「怎么拿 uaa-token」。" >&2
  exit 1
fi

# ego-browser 把 console.log 写到 stderr，所以这里收 stderr、丢 stdout。
TOKEN=$(ego-browser nodejs <<'EOF' 2>&1 >/dev/null | grep -E '^eyJ[A-Za-z0-9_.-]+$' | tail -1
const task = await taskSpace("intern token");
const page = task.page("p1");
await page.goto("https://discovery.intern-ai.org.cn/token-plan/home?tabIndex=0&lang=zh-CN");
await page.waitForTimeout(3000);
const cookies = await page.cdp("Network.getAllCookies", {});
const tok = (cookies.cookies || []).find((c) => c.name === "uaa-token")?.value;
if (!tok) {
  console.error("NO_TOKEN");
  process.exit(1);
}
console.log(tok);
EOF
)

if [ -z "$TOKEN" ]; then
  echo "没取到 uaa-token。先在 ego-browser 里登录 https://discovery.intern-ai.org.cn" >&2
  exit 1
fi

if [ "$TOKEN_ONLY" -eq 1 ] || [ -z "$KEY" ]; then
  printf '%s\n' "$TOKEN"
else
  printf '%s|%s\n' "$KEY" "$TOKEN"
fi
