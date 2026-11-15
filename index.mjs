// Clixad CLI as a Magpie / OpenCode provider plugin.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIXAD_ID = "clixad";
export const CLIXAD_GATEWAY_ENV = "CLIXAD_GATEWAY_URL";
export const CLIXAD_DEFAULT_GATEWAY = "https://clixad.onrender.com";

const BOOTSTRAP_MODELS = [
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    context_window: 1_000_000,
    efforts: [],
    free: true,
    access: "budget"
  }
];

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameEndpoint(left, right) {
  const normalize = (value) => {
    try {
      const url = new URL(value);
      const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
      return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return trimSlash(value);
    }
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
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
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

function modelName(model, turnsLeft) {
  const base = String(model.label || model.id);
  if (model.free === true) {
    const turns = finiteNumber(turnsLeft);
    return `${base} · 免费${turns !== null && turns >= 0 ? ` · ${Math.floor(turns)} 回合` : ""}`;
  }
  if (model.access === "premium") return `${base} · Premium`;
  return base;
}

function toModel(model, turnsLeft) {
  const efforts = Array.isArray(model.efforts) ? model.efforts.filter((item) => typeof item === "string") : [];
  const reasoning = efforts.length > 0;
  const inputCredits = finiteNumber(model.credits_per_mtoken_input);
  const outputCredits = finiteNumber(model.credits_per_mtoken_output);
  const taskCredits = finiteNumber(model.est_credits_per_task);
  const adsPerTask = finiteNumber(model.est_ads_per_task);
  const hasCredits = [inputCredits, outputCredits, taskCredits, adsPerTask].some((value) => value !== null);
  const free = model.free === true;

  return {
    id: model.id,
    name: modelName(model, turnsLeft),
    free,
    rate: inputCredits ?? 0,
    limit: { context: finiteNumber(model.context_window) || 128_000 },
    reasoning,
    tool_call: true,
    ...(reasoning ? { efforts, default_effort: model.default_effort } : {}),
    ...(typeof model.access === "string" ? { access: model.access } : {}),
    ...(model.access_until ? { access_until: model.access_until } : {}),
    ...(typeof model.auto_mode === "boolean" ? { auto_mode: model.auto_mode } : {}),
    ...(hasCredits
      ? {
          credits: {
            inputPerMtoken: inputCredits ?? 0,
            outputPerMtoken: outputCredits ?? 0,
            estimatePerTask: taskCredits ?? 0,
            adsPerTask: adsPerTask ?? 0
          }
        }
      : {}),
    ...(free ? { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } : {}),
    capabilities: {
      reasoning,
      toolcall: true,
      input: { text: true },
      output: { text: true }
    }
  };
}

function bootstrapModels() {
  return Object.fromEntries(BOOTSTRAP_MODELS.map((model) => [model.id, toModel(model)]));
}

export function createClixadPlugin({
  env = process.env,
  homeDir,
  configFile,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const resolvedConfigFile = configFile || join(homeDir || env.HOME || homedir(), ".clixad", "config.json");
  const envGateway = trimSlash(env[CLIXAD_GATEWAY_ENV]);

  const readConfig = () => {
    if (!existsSync(resolvedConfigFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(resolvedConfigFile, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const gatewayFor = (config = readConfig()) => {
    const tokenGateway = trimSlash(config.tokenGateway);
    return envGateway || trimSlash(config.gatewayUrl) || tokenGateway || CLIXAD_DEFAULT_GATEWAY;
  };

  const localLogin = () => {
    const config = readConfig();
    const token = typeof config.token === "string" ? config.token.trim() : "";
    const gatewayUrl = gatewayFor(config);
    const boundGateway = trimSlash(config.tokenGateway) || trimSlash(config.gatewayUrl);

    if (!token) {
      throw new Error("未找到 Clixad 本地登录态。请先在终端运行 `clixad login` 完成登录。");
    }
    if (boundGateway && !sameEndpoint(boundGateway, gatewayUrl)) {
      throw new Error(
        `Clixad 登录态绑定的是 ${boundGateway}，当前网关是 ${gatewayUrl}。` +
        "为避免把 token 发给错误网关，请先运行 `clixad login` 重新登录。"
      );
    }

    const metadata = {
      gatewayUrl,
      source: "clixad-cli",
      ...(config.email ? { email: config.email } : {}),
      ...(config.userId ? { userId: config.userId } : {})
    };
    return {
      type: "success",
      key: token,
      metadata,
      async callback() {
        return { type: "success", key: token, metadata };
      }
    };
  };

  const authView = (auth) => {
    const metadata = isRecord(auth?.metadata) ? auth.metadata : {};
    const key = auth?.key || auth?.access || metadata.key || metadata.access || "";
    const gatewayUrl = trimSlash(metadata.gatewayUrl) || gatewayFor();
    return { key: typeof key === "string" ? key.trim() : "", gatewayUrl };
  };

  const credentialsFor = (auth) => {
    const visible = authView(auth);
    if (visible.key) return visible;
    try {
      const local = localLogin();
      return { key: local.key, gatewayUrl: local.metadata.gatewayUrl };
    } catch {
      return { key: "", gatewayUrl: gatewayFor() };
    }
  };

  const request = async (url, token) => {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15_000)
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A non-JSON error is still reported through the HTTP status.
    }
    return { response, data };
  };

  const requestJson = async (url, token) => {
    const { response, data } = await request(url, token);
    return response.ok ? data : null;
  };

  const nextUtcMidnight = () => {
    const date = new Date(Number(now()));
    date.setUTCHours(24, 0, 0, 0);
    return date.toISOString();
  };

  const usageWindows = (wallet) => {
    const free = isRecord(wallet?.free_tier) ? wallet.free_tier : {};
    const daily = Math.max(0, finiteNumber(free.daily_credits) ?? 0);
    const extra = Math.max(0, finiteNumber(free.extra_credits) ?? 0);
    const left = Math.max(0, finiteNumber(free.credits_left) ?? 0);
    const turns = Math.max(0, finiteNumber(free.turns_left) ?? 0);
    const duringDay = Math.min(left, daily);
    const used = daily > 0 ? Math.max(0, Math.min(100, Math.round(((daily - duringDay) / daily) * 100))) : 0;
    const windows = [
      {
        name: "每日免费额度 (UTC 零点重置)",
        used,
        display: `${left.toLocaleString("en-US")} / ${daily.toLocaleString("en-US")} credits` +
          ` · ${turns.toLocaleString("en-US")} 回合` +
          (extra > 0 ? ` · 额外 ${extra.toLocaleString("en-US")} credits` : ""),
        resetsAt: nextUtcMidnight()
      }
    ];

    const spendable = isRecord(wallet?.spendable) ? wallet.spendable : {};
    const budget = Math.max(0, finiteNumber(spendable.budget) ?? finiteNumber(wallet?.balance) ?? 0);
    windows.push({
      name: "Budget credits",
      used: 0,
      display: `${budget.toLocaleString("en-US")} credits`
    });

    const premium = isRecord(wallet?.premium) ? wallet.premium : {};
    const premiumCredits = Math.max(0, finiteNumber(premium.credits) ?? finiteNumber(spendable.premium) ?? 0);
    windows.push({
      name: "Premium credits",
      used: 0,
      display: premium.unlocked === true
        ? `${premiumCredits.toLocaleString("en-US")} premium credits · 已解锁`
        : `${premiumCredits.toLocaleString("en-US")} premium credits · 未解锁`
    });

    return windows;
  };

  return {
    config: async (cfg) => {
      const gatewayUrl = gatewayFor();
      cfg.provider ??= {};
      cfg.provider[CLIXAD_ID] ??= {
        name: "Clixad",
        npm: "@ai-sdk/openai-compatible",
        api: `${gatewayUrl}/v1`,
        models: bootstrapModels()
      };
    },

    provider: {
      id: CLIXAD_ID,
      async models(provider, { auth } = {}) {
        const fallback = provider?.models || bootstrapModels();
        const { key, gatewayUrl } = credentialsFor(auth);
        if (!key) return fallback;

        const [catalog, wallet] = await Promise.all([
          requestJson(`${gatewayUrl}/v1/models`, key).catch(() => null),
          requestJson(`${gatewayUrl}/v1/wallet?premium=1`, key).catch(() => null)
        ]);
        const liveModels = Array.isArray(catalog?.data) ? catalog.data : [];
        if (liveModels.length === 0) return fallback;

        const turnsLeft = wallet?.free_tier?.turns_left;
        return Object.fromEntries(liveModels.map((model) => [model.id, toModel(model, turnsLeft)]));
      }
    },

    auth: {
      provider: CLIXAD_ID,
      methods: [
        {
          type: "oauth",
          label: "Clixad CLI 登录态（自动复用本地登录）",
          async authorize() {
            try {
              return localLogin();
            } catch (error) {
              return { type: "failed", error: redact(error?.message || error) };
            }
          }
        },
        {
          type: "api",
          label: "Clixad Bearer Token（手动填入）",
          placeholder: "Clixad token"
        }
      ],

      async usage(getAuth) {
        let key = "";
        try {
          const auth = await getAuth();
          const credentials = credentialsFor(auth);
          key = credentials.key;
          if (!key) {
            return {
              error: "未登录 Clixad。请先在终端运行 `clixad login`，或手动填入 Bearer Token。",
              windows: []
            };
          }

          const { response, data } = await request(`${credentials.gatewayUrl}/v1/wallet?premium=1`, key);
          if (response.status === 401) {
            const error = new Error("Clixad 登录态已过期，请在终端运行 `clixad login` 重新登录。");
            error.invalidToken = true;
            throw error;
          }
          if (!response.ok) throw new Error(`Clixad /v1/wallet returned HTTP ${response.status}`);
          if (!isRecord(data)) throw new Error("Clixad /v1/wallet returned an invalid body");

          const metadata = isRecord(auth?.metadata) ? auth.metadata : {};
          return {
            plan: data?.premium?.unlocked === true ? "Clixad Free + Premium" : "Clixad Free",
            user: metadata.email || metadata.userId || "Clixad user",
            windows: usageWindows(data)
          };
        } catch (error) {
          const detail = redact(error?.message || error, [key]);
          return {
            error: error?.invalidToken ? detail : `读取额度失败: ${detail}`,
            ...(error?.invalidToken ? { signIn: "expired" } : {}),
            windows: []
          };
        }
      },

      async loader(getAuth) {
        const initial = authView(await getAuth());
        return {
          baseURL: `${initial.gatewayUrl}/v1`,
          apiKey: initial.key,
          async fetch(input, init = {}) {
            const current = authView(await getAuth());
            if (!current.key) {
              throw new Error("未登录 Clixad。请先在终端运行 `clixad login`，或手动填入 Bearer Token。");
            }

            const request = input instanceof Request ? input : null;
            const sourceUrl = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : request?.url;
            if (!sourceUrl) throw new Error("Clixad 请求缺少 URL");

            const source = new URL(sourceUrl, `${current.gatewayUrl}/v1/`);
            const url = `${current.gatewayUrl}${source.pathname}${source.search}`;
            const headers = new Headers(init.headers ?? request?.headers);
            headers.set("Authorization", `Bearer ${current.key}`);
            headers.set("Content-Type", "application/json");

            let body = init.body;
            if (source.pathname.endsWith("/chat/completions") && typeof body === "string") {
              const payload = JSON.parse(body);
              if (payload.stream === undefined) payload.stream = false;
              body = JSON.stringify(payload);
            }

            try {
              return await fetchImpl(url, { ...init, headers, body });
            } catch (error) {
              const detail = redact(error?.message || error, [current.key]);
              throw new Error(`Clixad 请求失败: ${detail}`);
            }
          }
        };
      }
    }
  };
}

export const ClixadPlugin = async () => createClixadPlugin();

export default ClixadPlugin;
