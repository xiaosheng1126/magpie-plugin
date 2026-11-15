// HowToFix CLI Grok models as a Magpie / OpenCode provider plugin.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOWTOFIX_ID = "howtofix";
export const HOWTOFIX_BASE_URL = "https://api.howtofix.id/v1";

const DEFAULT_CLI_VERSION = "0.7.46";
const BOOTSTRAP_MODELS = [
  {
    id: "grok-4.5",
    contextWindow: 500_000,
    maxTokens: 500_000,
    reasoning: true,
    input: ["text", "image"],
    plans: ["free", "vip"],
    plan: "free"
  },
  {
    id: "grok-4.5-liberated-sg",
    contextWindow: 128_000,
    plans: ["free", "vip"],
    plan: "free"
  },
  {
    id: "grok-4.6",
    contextWindow: 500_000,
    maxTokens: 500_000,
    reasoning: true,
    input: ["text", "image"],
    plans: ["free", "vip"],
    plan: "free"
  },
  {
    id: "grok-4.6-liberated-sg",
    contextWindow: 128_000,
    plans: ["free", "vip"],
    plan: "free"
  },
  {
    id: "grok-4.7",
    contextWindow: 500_000,
    maxTokens: 500_000,
    reasoning: true,
    input: ["text", "image"],
    plans: ["free", "vip"],
    plan: "free"
  },
  {
    id: "grok-4.7-liberated-sg",
    contextWindow: 128_000,
    plans: ["free", "vip"],
    plan: "free"
  }
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function redact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:accessToken|refreshToken|token|key)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

function modelName(id, metadata) {
  const base = typeof metadata.name === "string" && metadata.name.trim()
    ? metadata.name.trim()
    : id
      .replace(/^grok-/i, "Grok ")
      .replace(/-liberated-sg$/i, " Liberated SG")
      .replace(/-/g, " ");
  const plans = Array.isArray(metadata.plans) ? metadata.plans : [];
  return plans.includes("free") ? `${base} · Free` : base;
}

function toModel(id, metadata = {}) {
  const context = finiteNumber(metadata.contextWindow)
    ?? finiteNumber(metadata.limit?.context)
    ?? 128_000;
  const output = finiteNumber(metadata.maxTokens)
    ?? finiteNumber(metadata.limit?.output);
  const plans = Array.isArray(metadata.plans)
    ? metadata.plans.filter((item) => typeof item === "string")
    : [];
  const inputs = Array.isArray(metadata.input)
    ? metadata.input.filter((item) => typeof item === "string")
    : [];
  const free = metadata.free === true || plans.includes("free");
  const reasoning = metadata.reasoning === true;

  return {
    id,
    name: modelName(id, metadata),
    free,
    rate: 0,
    limit: {
      context,
      ...(output !== null ? { output } : {})
    },
    reasoning,
    tool_call: true,
    ...(plans.length > 0 ? { plans } : {}),
    ...(typeof metadata.plan === "string" ? { plan: metadata.plan } : {}),
    ...(free ? { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } : {}),
    capabilities: {
      reasoning,
      toolcall: true,
      input: {
        text: true,
        ...(inputs.includes("image") ? { image: true } : {})
      },
      output: { text: true }
    }
  };
}

function bootstrapModels() {
  return Object.fromEntries(BOOTSTRAP_MODELS.map((model) => [model.id, toModel(model.id, model)]));
}

export function createHowtofixPlugin({
  env = process.env,
  homeDir,
  authFile,
  credentialFile,
  modelsFile,
  cliPackageFile,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const home = homeDir || env.HOME || homedir();
  const agentDir = join(home, ".howtofix", "agent");
  const resolvedAuthFile = authFile || join(agentDir, "auth.json");
  const resolvedCredentialFile = credentialFile || join(agentDir, "cli-credentials.json");
  const resolvedModelsFile = modelsFile || join(agentDir, "models.json");

  const cliVersion = () => {
    const candidates = [
      cliPackageFile,
      join(home, ".local", "lib", "node_modules", "howtofixcli", "package.json"),
      "/usr/local/lib/node_modules/howtofixcli/package.json",
      "/opt/homebrew/lib/node_modules/howtofixcli/package.json"
    ].filter(Boolean);

    for (const file of candidates) {
      const version = readJson(file).version;
      if (typeof version === "string" && version.trim()) return version.trim();
    }
    return DEFAULT_CLI_VERSION;
  };

  const selectedAuth = (magpieAuth) => {
    const credentials = readJson(resolvedCredentialFile);
    const accessToken = typeof credentials.accessToken === "string"
      ? credentials.accessToken.trim()
      : "";
    const accessExpiresAt = finiteNumber(credentials.accessExpiresAt);
    if (
      accessToken &&
      (accessExpiresAt === null || accessExpiresAt > Math.floor(Number(now()) / 1000))
    ) {
      return { key: accessToken, source: "howtofix-cli" };
    }

    const auth = readJson(resolvedAuthFile);
    const localKey = auth?.howtofix?.key ?? auth?.key;
    if (typeof localKey === "string" && localKey.trim()) {
      return { key: localKey.trim(), source: "howtofix-auth" };
    }

    const metadata = isRecord(magpieAuth?.metadata) ? magpieAuth.metadata : {};
    const key = magpieAuth?.key ?? magpieAuth?.access ?? metadata.key ?? metadata.access;
    if (typeof key === "string" && key.trim()) {
      return { key: key.trim(), source: "magpie" };
    }

    return { key: "", source: "" };
  };

  const headersFor = (key) => ({
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "X-HowToFix-Client": `CLI (${cliVersion()})`
  });

  const reconnectError = () =>
    "HowToFix 登录态已过期，请在终端运行 `howtofix` 后执行 `/connect` 重新登录。";

  const catalogModels = () => {
    const catalog = readJson(resolvedModelsFile);
    const models = catalog?.providers?.howtofix?.models;
    if (!Array.isArray(models)) return {};
    return Object.fromEntries(
      models
        .filter((model) => isRecord(model) && typeof model.id === "string")
        .map((model) => [model.id, model])
    );
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[HOWTOFIX_ID] ??= {
        name: "HowToFix",
        npm: "@ai-sdk/openai-compatible",
        api: HOWTOFIX_BASE_URL,
        models: bootstrapModels()
      };
    },

    provider: {
      id: HOWTOFIX_ID,
      async models(provider, { auth } = {}) {
        const fallback = isRecord(provider?.models) ? provider.models : bootstrapModels();
        const current = selectedAuth(auth);
        if (!current.key) return fallback;

        try {
          const response = await fetchImpl(`${HOWTOFIX_BASE_URL}/models`, {
            headers: headersFor(current.key),
            signal: AbortSignal.timeout(15_000)
          });
          if (!response.ok) return fallback;

          const body = await response.json();
          const entries = Array.isArray(body?.data) ? body.data : [];
          const live = entries
            .map((entry) => (typeof entry === "string" ? { id: entry } : entry))
            .filter((entry) => isRecord(entry) && typeof entry.id === "string")
            .filter((entry) => entry.id.startsWith("grok-"));
          if (live.length === 0) return fallback;

          const metadata = catalogModels();
          return Object.fromEntries(live.map((entry) => [
            entry.id,
            toModel(entry.id, { ...(metadata[entry.id] || {}), ...entry })
          ]));
        } catch {
          return fallback;
        }
      }
    },

    auth: {
      provider: HOWTOFIX_ID,
      methods: [
        {
          type: "oauth",
          label: "HowToFix CLI 登录态（自动复用本地登录）",
          async authorize() {
            const current = selectedAuth();
            if (!current.key) return { type: "failed", error: reconnectError() };

            try {
              const response = await fetchImpl(`${HOWTOFIX_BASE_URL}/models`, {
                headers: headersFor(current.key),
                signal: AbortSignal.timeout(15_000)
              });
              if (!response.ok) {
                return {
                  type: "failed",
                  error: redact(
                    response.status === 401 || response.status === 403
                      ? reconnectError()
                      : `HowToFix 登录态验证失败: /models 返回 HTTP ${response.status}`,
                    [current.key]
                  )
                };
              }
              const metadata = { source: current.source };
              return {
                type: "success",
                key: current.key,
                metadata,
                async callback() {
                  return { type: "success", key: current.key, metadata };
                }
              };
            } catch (error) {
              return {
                type: "failed",
                error: redact(`HowToFix 登录态验证失败: ${error?.message || error}`, [current.key])
              };
            }
          }
        },
        {
          type: "api",
          label: "HowToFix Token（手动填入）",
          placeholder: "HowToFix bearer token"
        }
      ],

      async usage(getAuth) {
        let key = "";
        try {
          const auth = typeof getAuth === "function" ? await getAuth() : undefined;
          const current = selectedAuth(auth);
          key = current.key;
          if (!key) {
            return {
              error: reconnectError(),
              signIn: "expired",
              windows: []
            };
          }

          const origin = new URL(HOWTOFIX_BASE_URL).origin;
          const billingHeaders = {
            Authorization: `Bearer ${key}`,
            Accept: "application/json"
          };
          const unitRequest = fetchImpl(`${origin}/api/status`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15_000)
          }).then(async (response) => {
            if (!response.ok) return "USD";
            const body = await response.json();
            const unit = body?.data?.quota_display_type;
            return typeof unit === "string" && unit.trim()
              ? unit.trim().toUpperCase()
              : "USD";
          }).catch(() => "USD");

          const [unit, subscriptionResponse, usageResponse] = await Promise.all([
            unitRequest,
            fetchImpl(`${origin}/dashboard/billing/subscription`, {
              headers: billingHeaders,
              signal: AbortSignal.timeout(15_000)
            }),
            fetchImpl(`${origin}/dashboard/billing/usage`, {
              headers: billingHeaders,
              signal: AbortSignal.timeout(15_000)
            })
          ]);

          if (
            subscriptionResponse.status === 401 ||
            subscriptionResponse.status === 403 ||
            usageResponse.status === 401 ||
            usageResponse.status === 403
          ) {
            const error = new Error(reconnectError());
            error.invalidToken = true;
            throw error;
          }
          if (!subscriptionResponse.ok) {
            throw new Error(
              `HowToFix /dashboard/billing/subscription 返回 HTTP ${subscriptionResponse.status}`
            );
          }
          if (!usageResponse.ok) {
            throw new Error(`HowToFix /dashboard/billing/usage 返回 HTTP ${usageResponse.status}`);
          }

          const subscription = await subscriptionResponse.json();
          const usageBody = await usageResponse.json();
          if (!isRecord(subscription)) {
            throw new Error("HowToFix /dashboard/billing/subscription 返回了无效数据");
          }
          if (!isRecord(usageBody)) {
            throw new Error("HowToFix /dashboard/billing/usage 返回了无效数据");
          }

          const limit = finiteNumber(subscription.hard_limit_usd ?? subscription.soft_limit_usd);
          const totalUsage = finiteNumber(usageBody.total_usage);
          if (limit === null) {
            throw new Error("HowToFix 余额响应缺少可用总额度");
          }
          if (totalUsage === null) {
            throw new Error("HowToFix 用量响应缺少 total_usage");
          }

          const unlimited = limit >= 100_000_000;
          const used = totalUsage / 100;
          const remaining = Math.max(0, limit - used);
          const amount = (value) => (
            unit === "USD"
              ? `$${value.toFixed(2)}`
              : `${value.toFixed(2)} ${unit}`
          );
          const metadata = isRecord(auth?.metadata) ? auth.metadata : {};

          return {
            plan: `HowToFix CLI · ${unit}`,
            user: metadata.display_name || metadata.username || metadata.name || "HowToFix user",
            windows: [{
              name: "账户余额",
              used: unlimited || limit <= 0
                ? 0
                : Math.max(0, Math.min(100, (used / limit) * 100)),
              display: unlimited
                ? "unlimited"
                : `${amount(remaining)} 可用 · ${amount(used)} 已用 / ${amount(limit)} 总额`
            }],
            signIn: "kept"
          };
        } catch (error) {
          const detail = redact(error?.message || error, [key]);
          return {
            error: error?.invalidToken ? detail : `读取 HowToFix 余额失败: ${detail}`,
            ...(error?.invalidToken ? { signIn: "expired" } : {}),
            windows: []
          };
        }
      },

      async loader(getAuth) {
        const getCurrentAuth = async () => (
          typeof getAuth === "function" ? getAuth() : undefined
        );
        const initial = selectedAuth(await getCurrentAuth());

        return {
          baseURL: HOWTOFIX_BASE_URL,
          apiKey: initial.key,
          async fetch(input, init = {}) {
            const current = selectedAuth(await getCurrentAuth());
            if (!current.key) throw new Error(reconnectError());

            const request = input instanceof Request ? input : null;
            const sourceUrl = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : request?.url;
            if (!sourceUrl) throw new Error("HowToFix 请求缺少 URL");

            const source = new URL(sourceUrl, `${HOWTOFIX_BASE_URL}/`);
            const url = `${new URL(HOWTOFIX_BASE_URL).origin}${source.pathname}${source.search}`;
            const headers = new Headers(init.headers ?? request?.headers);
            headers.set("Authorization", `Bearer ${current.key}`);
            headers.set("X-HowToFix-Client", `CLI (${cliVersion()})`);
            if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

            const body = init.body !== undefined ? init.body : request?.body;
            const options = { ...init, headers };
            if (body !== undefined) options.body = body;

            let response;
            try {
              response = await fetchImpl(url, options);
            } catch (error) {
              throw new Error(
                `HowToFix 请求失败: ${redact(error?.message || error, [current.key])}`
              );
            }

            if (response.status === 401) {
              return new Response(JSON.stringify({
                error: {
                  message: reconnectError(),
                  type: "authentication_error",
                  code: "howtofix_auth_expired"
                }
              }), {
                status: 401,
                headers: { "content-type": "application/json" }
              });
            }
            return response;
          }
        };
      }
    }
  };
}

export const HowtofixPlugin = async () => createHowtofixPlugin();

export default HowtofixPlugin;
