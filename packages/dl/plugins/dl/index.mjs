import { randomUUID } from "node:crypto";
import {
  dlPaths,
  fetchWithTimeout,
  isRecord,
  readJsonFile,
  safeErrorMessage,
  toModelMap,
  toProviderModel,
  withFileLock,
  writeJsonAtomic
} from "../../shared/core.mjs";

export const DL_ID = "directionally-local";
export const DL_REFRESH_LEAD_MS = 60_000;
export const DL_TOKEN_ENV = "AUTOPILOT_DL_FREE_TOKEN";
const DL_USER_AGENT = "autopilot/3.22.0 (+https://github.com/directionally-local/autopilot)";

export const DL_MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", context: 1_050_000, output: 128_000, vision: true, reasoning: true },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", context: 1_050_000, output: 128_000, vision: true, reasoning: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", context: 1_050_000, output: 128_000, vision: true, reasoning: true },
  { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", context: 1_048_576, output: 65_536, vision: false, reasoning: true }
];

function dlOrigin(env) {
  return (env.AUTOPILOT_DL_FREE_URL || "https://free.directionallylocal.com")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

function toDlModel(model) {
  return toProviderModel({
    id: model.id,
    name: `${model.name} · 免费`,
    context: model.context,
    output: model.output,
    reasoning: model.reasoning,
    toolCall: true,
    vision: model.vision,
    input: 0,
    outputPrice: 0,
    free: true
  });
}

function dlModels() {
  return toModelMap(DL_MODELS.map(toDlModel));
}

function readDlSettings(configFile) {
  const config = readJsonFile(configFile, null);
  return isRecord(config?.providers?.[DL_ID]) ? config.providers[DL_ID] : null;
}

function credentialFromSettings(settings) {
  return {
    access: settings.apiKey,
    refresh: settings.refreshToken || "",
    expires: Number(settings.expiresAt) || 0
  };
}

function saveDlSettings(configFile, patch) {
  const current = readJsonFile(configFile, null);
  const config = isRecord(current) ? { ...current } : {};
  const providers = isRecord(config.providers) ? { ...config.providers } : {};
  const provider = isRecord(providers[DL_ID]) ? { ...providers[DL_ID] } : {};
  Object.assign(provider, patch);
  providers[DL_ID] = provider;
  config.providers = providers;
  writeJsonAtomic(configFile, config);
  return config;
}

function refreshHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": DL_USER_AGENT
  };
}

async function meRequest({ origin, fetchImpl, token }) {
  const response = await fetchWithTimeout(fetchImpl, `${origin}/v1/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": DL_USER_AGENT
    }
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error("dl 凭据已失效，请在终端运行 `dl` 重新登录。");
    error.invalidToken = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`dl /me returned HTTP ${response.status}`);
  return response.json();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.max(0, number);
}

function percentage(used, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function formatTokens(value) {
  return Math.floor(nonNegativeNumber(value)).toLocaleString("en-US");
}

function formatUsd(value) {
  const number = nonNegativeNumber(value);
  return `$${number.toFixed(number > 0 && number < 0.01 ? 4 : 2)}`;
}

function allowanceSummary(me) {
  const allowance = isRecord(me?.allowance) ? me.allowance : {};
  const windows = [];

  if (isRecord(me?.budgets)) {
    for (const [familyKey, budget] of Object.entries(me.budgets)) {
      if (familyKey !== "gpt6" && familyKey !== "deepseek") continue;
      if (!isRecord(budget)) continue;
      const usdLimit = budget.usdPerWeek === null ? null : nonNegativeNumber(budget.usdPerWeek);
      const spentUsd = nonNegativeNumber(budget.spentUsd);
      if (usdLimit !== null && !(usdLimit > 0)) continue;
      windows.push({
        name: familyKey === "gpt6" ? "GPT-6" : "DEEPSEEK",
        used: usdLimit === null ? 0 : percentage(spentUsd, usdLimit),
        display: usdLimit === null
          ? `${formatUsd(spentUsd)} used · 无上限`
          : `${formatUsd(Math.max(0, usdLimit - spentUsd))} / ${formatUsd(usdLimit)} 剩余`,
        resetsAt: allowance.resetsAt
      });
    }
  }

  const planName = me?.plan === "pro" ? "DL Pro" : me?.plan === "free" ? "DL Free" : "DL";
  const level = typeof me?.level === "string" ? ` · ${me.level.toUpperCase()}` : "";

  return {
    plan: `${planName}${level}`,
    user: me?.login || "dl user",
    windows,
    signIn: "kept"
  };
}

function accountIdentity(me) {
  return String(me?.githubId || me?.login || "dl");
}

function repairBody(body) {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return body;
}

function parseRequestJson(body) {
  const text = repairBody(body);
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shapeChatPayload(input) {
  if (!isRecord(input) || !input.model || !Array.isArray(input.messages)) return null;
  const payload = {
    model: input.model,
    messages: input.messages,
    stream: true
  };
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    payload.tools = input.tools;
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = true;
  }
  payload.temperature = 0.2;
  payload.max_tokens = 16_384;
  payload.stream_options = { include_usage: true };
  return payload;
}

function isChatRequest(input) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  return /\/chat\/completions\/?$/i.test(url || "");
}

async function refreshLocalCredential({
  fetchImpl,
  now,
  env,
  credential
}) {
  if (!credential.refresh) throw expiredSignIn();

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${dlOrigin(env)}/v1/token/refresh`, {
      method: "POST",
      headers: refreshHeaders(),
      body: JSON.stringify({ refresh_token: credential.refresh })
    });
  } catch (error) {
    throw new Error(`刷新 dl 登录态失败: ${safeErrorMessage(error, [credential.access, credential.refresh])}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    const message = data?.error_description || data?.error || `HTTP ${response.status}`;
    const error = data?.error === "invalid_grant"
      ? expiredSignIn("dl 登录态已过期，请在终端运行 `dl` 重新登录。")
      : new Error("dl 登录态刷新失败，请在终端运行 `dl` 重新登录。");
    error.message = `${error.message} (${safeErrorMessage(message, [credential.access, credential.refresh])})`;
    throw error;
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token || credential.refresh,
    expires: now() + Number(data.expires_in || 3600) * 1000
  };
}

function credentialMatches(settings, credential) {
  if (!settings?.apiKey || !credential) return false;
  if (credential.refresh && settings.refreshToken === credential.refresh) return true;
  return Boolean(credential.access && settings.apiKey === credential.access);
}

function expiredSignIn(message = "dl 登录态已过期，请在终端运行 `dl` 重新登录。") {
  const error = new Error(message);
  error.signIn = "expired";
  return error;
}

async function refreshAccountCredential({ configFile, lockFile, fetchImpl, now, env, credential }) {
  const observed = readDlSettings(configFile);
  if (!credentialMatches(observed, credential)) {
    return refreshLocalCredential({ fetchImpl, now, env, credential });
  }

  return withFileLock(lockFile, async () => {
    const current = readDlSettings(configFile);
    if (!credentialMatches(current, credential)) {
      return refreshLocalCredential({ fetchImpl, now, env, credential });
    }
    if (credential.refresh && current.refreshToken === credential.refresh && current.apiKey !== credential.access) {
      return credentialFromSettings(current);
    }

    const refreshed = await refreshLocalCredential({ fetchImpl, now, env, credential });
    const latest = readDlSettings(configFile);
    if (!credentialMatches(latest, credential)) {
      throw expiredSignIn("dl CLI 账号在刷新期间发生变化，请重新添加账号。");
    }
    saveDlSettings(configFile, {
      apiKey: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires
    });
    return refreshed;
  });
}

async function resolveLocalCredential({ configFile, lockFile, fetchImpl, now, env }) {
  const current = readDlSettings(configFile);
  if (!current?.apiKey) return null;
  const fresh = !current.expiresAt || current.expiresAt - now() > DL_REFRESH_LEAD_MS;
  if (fresh) return credentialFromSettings(current);
  return refreshAccountCredential({
    configFile,
    lockFile,
    fetchImpl,
    now,
    env,
    credential: credentialFromSettings(current)
  });
}

export function createDlPlugin({
  env = process.env,
  homeDir,
  platform = process.platform,
  configFile,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomUUIDImpl = randomUUID
} = {}) {
  const paths = configFile
    ? { configFile, lockFile: `${configFile}.refresh.lock` }
    : dlPaths({ env, homeDir, platform });
  const baseURL = `${dlOrigin(env)}/v1`;
  const envToken = env[DL_TOKEN_ENV]?.trim();
  const refreshInFlight = new Map();

  const authView = (raw) => {
    if (!raw) return raw;
    const m = isRecord(raw?.metadata) ? raw.metadata : {};
    const expand = (key) => raw[key] ?? m[key];
    return {
      ...raw,
      type: raw.type === "api" && (m.type === "oauth" || expand("refresh")) ? "oauth" : raw.type,
      access: expand("access") ?? expand("key") ?? raw.key,
      refresh: expand("refresh") ?? raw.refresh,
      expires: expand("expires") ?? raw.expires,
      key: expand("key") ?? raw.key
    };
  };

  const tokenFor = async (getAuth) => {
    const auth = authView(typeof getAuth === "function" ? await getAuth() : undefined);
    if (auth?.type === "oauth") {
      const token = auth.access || auth.key || null;
      return { token, manual: false, refreshable: Boolean(token && auth.refresh) };
    }
    if (auth?.key) return { token: auth.key, manual: true };
    if (auth?.access) return { token: auth.access, manual: Boolean(!auth.refresh) };
    if (envToken) return { token: envToken, manual: true };
    return { token: null, manual: true };
  };

  const refreshAccount = async (auth) => {
    const expanded = authView(auth);
    const credential = {
      access: expanded?.access,
      refresh: expanded?.refresh || "",
      expires: Number(expanded?.expires) || 0
    };
    const key = credential.refresh || (credential.access ? `access:${credential.access}` : "");
    if (!key) {
      return refreshAccountCredential({ ...paths, fetchImpl, now, env, credential });
    }
    if (refreshInFlight.has(key)) return refreshInFlight.get(key);
    const pending = refreshAccountCredential({ ...paths, fetchImpl, now, env, credential })
      .finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, pending);
    return pending;
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[DL_ID] ??= {
        name: "DL",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        models: dlModels()
      };
    },

    provider: {
      id: DL_ID,
      async models() {
        return dlModels();
      }
    },

    auth: {
      provider: DL_ID,
      refreshLead: DL_REFRESH_LEAD_MS,
      rotating: true,
      maxConcurrency: 1,
      methods: [
        {
          type: "oauth",
          label: "dl CLI 登录态（自动续期）",
          async authorize() {
            try {
              let credential;
              try {
                credential = await resolveLocalCredential({
                  ...paths,
                  fetchImpl,
                  now,
                  env
                });
              } catch (error) {
                // 不因联网校验失败而阻止使用本地登录态，网络校验留给 usage/loader。
                const fallback = readDlSettings(paths.configFile);
                credential = fallback ? credentialFromSettings(fallback) : null;
                if (!credential?.access) throw error;
              }
              if (!credential?.access) {
                throw new Error("未找到 dl 本地登录态。请先在终端运行一次 `dl` 完成登录。");
              }
              let accountId = accountIdentity(null);
              try {
                const me = await meRequest({ origin: dlOrigin(env), fetchImpl, token: credential.access });
                accountId = accountIdentity(me);
              } catch {
                // 账号信息获取失败时使用兜底 ID，不阻塞登录。
              }
              const metadata = {
                access: credential.access,
                refresh: credential.refresh,
                expires: credential.expires,
                accountId,
                uid: accountId,
                handle: accountId,
                source: "dl-cli"
              };
              return {
                type: "success",
                key: credential.access,
                metadata,
                async callback() {
                  return {
                    type: "success",
                    access: credential.access,
                    refresh: credential.refresh,
                    expires: credential.expires,
                    accountId,
                    uid: accountId,
                    metadata
                  };
                }
              };
            } catch (error) {
              return { type: "failed", error: safeErrorMessage(error, [envToken]) };
            }
          }
        },
        {
          type: "api",
          label: "dl JWT Token（手动填入）",
          placeholder: "dl JWT token"
        }
      ],

      async refresh(auth) {
        return refreshAccount(auth);
      },

      async usage(getAuth) {
        try {
          const { token } = await tokenFor(getAuth);
          if (!token) return { error: "not signed in", windows: [] };
          return allowanceSummary(await meRequest({ origin: dlOrigin(env), fetchImpl, token }));
        } catch (error) {
          return {
            error: safeErrorMessage(error, [envToken]),
            ...(error?.invalidToken ? { signIn: "expired" } : {}),
            windows: []
          };
        }
      },

      async loader(getAuth) {
        const initial = await tokenFor(getAuth);
        return {
          baseURL,
          apiKey: initial.token,
          async fetch(input, init = {}) {
            const resolved = await tokenFor(getAuth);
            if (!resolved.token) throw new Error("dl 未登录，请先在终端运行 `dl`。");

            const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
            const session = headers.get("x-magpie-session");
            headers.delete("x-magpie-session");
            headers.set("Authorization", `Bearer ${resolved.token}`);
            headers.set("Content-Type", "application/json");
            headers.set("User-Agent", DL_USER_AGENT);

            let nextInit = { ...init, headers };
            if (isChatRequest(input)) {
              if (session) headers.set("X-Session-ID", session);
              headers.set("X-Request-ID", randomUUIDImpl());
              const shaped = shapeChatPayload(parseRequestJson(init.body ?? (input instanceof Request ? input.body : undefined)));
              if (shaped) nextInit = { ...nextInit, body: JSON.stringify(shaped) };
            }

            return fetchImpl(input, nextInit);
          }
        };
      }
    }
  };
}

export const DlPlugin = async ({ client } = {}) => {
  void client;
  return createDlPlugin();
};

export default DlPlugin;
export const _internal = {
  allowanceSummary,
  dlModels,
  dlOrigin,
  shapeChatPayload,
  toDlModel
};
