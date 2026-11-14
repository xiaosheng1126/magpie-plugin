import {
  MODEL_TTL_MS,
  apinexPaths,
  fetchWithTimeout,
  finitePrice,
  isRecord,
  parseContextTokens,
  readJsonFile,
  safeErrorMessage,
  toModelMap,
  toProviderModel,
  withFileLock,
  writeJsonAtomic
} from "../../shared/core.mjs";

export const APINEX_ID = "apinex";
export const APINEX_CLI_VERSION = "1.0.8";
export const APINEX_REFRESH_LEAD_MS = 30_000;
const CLI_SRC = "apinexcli";
const CLIENT_ID = "apinex-cli";

const BOOTSTRAP_MODELS = [
  { id: "free/mimo-v2.6-pro", name: "Mimo V2.6 Pro", provider: "Free", contextWindow: "1M", dollarsPer1M: 0, outputDollarsPer1M: 0, health: "live" },
  { id: "free/qwen-3.8-max", name: "Qwen 3.8 MAX", provider: "Free", contextWindow: "1M", dollarsPer1M: 0, outputDollarsPer1M: 0, health: "live" },
  { id: "free/kimi-k3", name: "Kimi K3", provider: "Free", contextWindow: "1M", dollarsPer1M: 0, outputDollarsPer1M: 0, health: "live" },
  { id: "free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash 1017", provider: "Free", contextWindow: "1M", dollarsPer1M: 0, outputDollarsPer1M: 0, health: "live" }
];

function apiOrigin(env) {
  return (env.APINEX_API_URL || "https://api.apinex.bond").trim().replace(/\/+$/, "");
}

function cliHeaders() {
  return {
    "User-Agent": `APInex-CLI/${APINEX_CLI_VERSION}`,
    src: CLI_SRC,
    "x-apinex-src": CLI_SRC
  };
}

function jsonRequest(body) {
  return {
    method: "POST",
    headers: { ...cliHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...body, src: CLI_SRC })
  };
}

function normalizeAuth(raw) {
  if (!isRecord(raw)) return null;
  return raw.accessToken ? raw : null;
}

function credentialFromAuth(auth) {
  return {
    access: auth.accessToken,
    refresh: auth.refreshToken || "",
    expires: Number(auth.expiresAt) || 0
  };
}

function saveAuthPatch(authFile, patch) {
  const current = readJsonFile(authFile, {});
  const next = isRecord(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "account" && value === undefined) continue;
    next[key] = value;
  }
  writeJsonAtomic(authFile, next);
  return next;
}

function credentialMatches(auth, credential) {
  if (!auth || !credential) return false;
  if (credential.refresh && auth.refreshToken === credential.refresh) return true;
  return Boolean(credential.access && auth.accessToken === credential.access);
}

function expiredSignIn(message) {
  const error = new Error(message);
  error.signIn = "expired";
  return error;
}

async function requestRefresh({ fetchImpl, now, env, credential }) {
  if (!credential.refresh) {
    throw expiredSignIn("APInex session expired. Run `apinex login` again.");
  }

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${apiOrigin(env)}/api/cli/oauth/token`, jsonRequest({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: credential.refresh
    }));
  } catch (error) {
    throw new Error(`Could not refresh APInex sign-in: ${safeErrorMessage(error, [credential.access, credential.refresh])}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    const message = data?.error_description || data?.error || `HTTP ${response.status}`;
    const error = data?.error === "invalid_grant"
      ? expiredSignIn("APInex session expired. Run `apinex login` again.")
      : new Error("APInex session refresh failed. Run `apinex login` again.");
    error.message = `${error.message} (${safeErrorMessage(message, [credential.access, credential.refresh])})`;
    throw error;
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token || credential.refresh,
    expires: now() + Number(data.expires_in || 3600) * 1000,
    account: Object.prototype.hasOwnProperty.call(data, "account") ? data.account : undefined
  };
}

async function refreshCredential({ paths, fetchImpl, now, env, credential }) {
  const observed = normalizeAuth(readJsonFile(paths.authFile, null));
  if (!credentialMatches(observed, credential)) {
    const refreshed = await requestRefresh({ fetchImpl, now, env, credential });
    return { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
  }

  return withFileLock(paths.lockFile, async () => {
    const current = normalizeAuth(readJsonFile(paths.authFile, null));
    if (!credentialMatches(current, credential)) {
      const refreshed = await requestRefresh({ fetchImpl, now, env, credential });
      return { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
    }
    if (credential.refresh && current.refreshToken === credential.refresh && current.accessToken !== credential.access) {
      return credentialFromAuth(current);
    }

    const refreshed = await requestRefresh({ fetchImpl, now, env, credential });
    const latest = normalizeAuth(readJsonFile(paths.authFile, null));
    if (!credentialMatches(latest, credential)) {
      throw expiredSignIn("APInex CLI account changed during refresh. Add the account again.");
    }
    saveAuthPatch(paths.authFile, {
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
      account: refreshed.account
    });
    return {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires
    };
  });
}

async function resolveLocalCredential({ paths, fetchImpl, now, env }) {
  const auth = normalizeAuth(readJsonFile(paths.authFile, null));
  if (!auth) return null;
  if (!auth.expiresAt || now() < auth.expiresAt - APINEX_REFRESH_LEAD_MS) {
    return credentialFromAuth(auth);
  }
  return refreshCredential({
    paths,
    fetchImpl,
    now,
    env,
    credential: credentialFromAuth(auth)
  });
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
  if (!isRecord(input)) return null;
  if (!input.model || !Array.isArray(input.messages)) return null;
  const payload = {
    model: input.model,
    messages: input.messages,
    stream: true,
    stream_options: { include_usage: true },
    src: CLI_SRC
  };
  if (Array.isArray(input.tools) && input.tools.length > 0) payload.tools = input.tools;
  return payload;
}

function isChatRequest(input) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  return /\/chat\/completions\/?$/i.test(url || "");
}

function toApinexModel(model) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const inputPrice = finitePrice(model?.dollarsPer1M);
  const outputPrice = finitePrice(model?.outputDollarsPer1M) ?? inputPrice;
  const providerName = String(model?.provider || "").toLowerCase();
  const free = id.startsWith("free/") || providerName === "free" || (inputPrice === 0 && outputPrice === 0);
  const health = String(model?.health || "live").toLowerCase();
  const baseName = String(model?.name || id).trim() || id;
  const priceName = free
    ? "免费"
    : inputPrice === null
      ? "价格未知"
      : outputPrice !== inputPrice
        ? `$${inputPrice}/M 输入 · $${outputPrice}/M 输出`
        : `$${inputPrice}/M`;
  const context = parseContextTokens(model?.contextWindow);

  return toProviderModel({
    id,
    name: `${baseName} · ${priceName}${health === "live" ? "" : ` · ${health}`}`,
    context,
    output: Math.min(8_192, context),
    reasoning: model?.reasoning === true,
    toolCall: model?.tool_call === true || model?.toolcall === true,
    vision: model?.vision === true,
    input: inputPrice ?? 0,
    outputPrice: outputPrice ?? inputPrice ?? 0,
    free,
    unavailable: health !== "live"
  });
}

function toModelMapSafe(models) {
  return toModelMap((Array.isArray(models) ? models : []).map(toApinexModel).filter(Boolean));
}

async function fetchLiveModels({ paths, fetchImpl, now, env }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, `${apiOrigin(env)}/api/public/models`, {
      headers: { ...cliHeaders(), Accept: "application/json" }
    });
  } catch (error) {
    throw new Error(`Could not load APInex models: ${safeErrorMessage(error)}`);
  }
  if (!response.ok) throw new Error(`APInex models returned HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  const models = Array.isArray(data?.models) ? data.models : [];
  if (models.length === 0) throw new Error("APInex returned an empty model catalog");
  try {
    writeJsonAtomic(paths.modelsFile, { updatedAt: now(), models });
  } catch {
    // Model discovery must still work when the CLI config directory is read-only.
  }
  return models;
}

function readCachedModels(paths, now) {
  const cached = readJsonFile(paths.modelsFile, null);
  const models = Array.isArray(cached?.models) ? cached.models : [];
  return {
    models,
    fresh: models.length > 0 && Number.isFinite(cached?.updatedAt) && now() - cached.updatedAt < MODEL_TTL_MS
  };
}

async function fetchAccount({ apiOrigin: origin, fetchImpl, token }) {
  const response = await fetchWithTimeout(fetchImpl, `${origin}/api/cli/account`, {
    headers: { ...cliHeaders(), Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error("APInex sign-in expired. Run `apinex login` again.");
    error.signIn = "expired";
    throw error;
  }
  if (!response.ok) throw new Error(`APInex account returned HTTP ${response.status}`);
  return response.json();
}

function accountUsage(account) {
  const access = isRecord(account?.access) ? account.access : {};
  const subscription = isRecord(account?.subscription) ? account.subscription : null;
  const quota = subscription || access;
  const unlimited = Boolean(quota.unlimited);
  const limit = Number(quota.tokenLimit ?? quota.limit ?? 0);
  const used = Number(quota.used ?? quota.tokensUsed ?? 0);
  const percent = unlimited || !(limit > 0) ? 0 : Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  const plan = subscription?.label || access.planLabel || "FREE";
  const balance = Number(account?.balanceUsd ?? 0);
  const windows = [{
    name: `${plan} token allowance`,
    used: percent,
    display: unlimited ? "无限额度" : `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} tokens used`,
    resetsAt: quota.resetsAt
  }];
  if (Number.isFinite(balance)) {
    windows.push({
      name: "USD balance",
      used: 0,
      display: `$${balance.toFixed(balance > 0 && balance < 0.01 ? 4 : 2)}`
    });
  }
  return {
    plan,
    user: account?.user?.email || account?.user?.name || "APInex user",
    windows,
    signIn: "kept"
  };
}

function accountIdentity(account) {
  return String(
    account?.user?.email ||
    account?.user?.id ||
    account?.accountId ||
    account?.id ||
    "apinex"
  );
}

export function createApiNexPlugin({
  env = process.env,
  homeDir,
  platform = process.platform,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const paths = apinexPaths({ env, homeDir, platform });
  const baseURL = `${apiOrigin(env)}/v1`;
  const refreshInFlight = new Map();
  let modelsInFlight;

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
      return refreshCredential({ paths, fetchImpl, now, env, credential });
    }
    if (refreshInFlight.has(key)) return refreshInFlight.get(key);
    const pending = refreshCredential({ paths, fetchImpl, now, env, credential })
      .finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, pending);
    return pending;
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const cached = readCachedModels(paths, now);
      cfg.provider[APINEX_ID] ??= {
        name: "APInex",
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        models: cached.models.length > 0 ? toModelMapSafe(cached.models) : toModelMapSafe(BOOTSTRAP_MODELS)
      };
    },

    provider: {
      id: APINEX_ID,
      async models(provider) {
        const cached = readCachedModels(paths, now);
        if (cached.fresh) return toModelMapSafe(cached.models);
        if (modelsInFlight) return modelsInFlight;

        const pending = fetchLiveModels({ paths, fetchImpl, now, env })
          .then((models) => toModelMapSafe(models))
          .finally(() => {
            if (modelsInFlight === pending) modelsInFlight = undefined;
          });
        modelsInFlight = pending;

        try {
          return await pending;
        } catch {
          if (cached.models.length > 0) return toModelMapSafe(cached.models);
          return provider?.models || toModelMapSafe(BOOTSTRAP_MODELS);
        }
      }
    },

    auth: {
      provider: APINEX_ID,
      refreshLead: APINEX_REFRESH_LEAD_MS,
      rotating: true,
      maxConcurrency: 1,
      methods: [
        {
          type: "oauth",
          label: "APInex CLI 登录态（自动续期）",
          async authorize() {
            try {
              let credential;
              try {
                credential = await resolveLocalCredential({ paths, fetchImpl, now, env });
              } catch (error) {
                // 不因联网校验失败而阻止使用本地登录态，网络校验留给 usage/loader。
                const fallback = normalizeAuth(readJsonFile(paths.authFile, null));
                credential = fallback ? credentialFromAuth(fallback) : null;
                if (!credential?.access) throw error;
              }
              if (!credential?.access) throw new Error("未找到 APInex CLI 登录态，请先运行 `apinex login`。");
              let accountId = accountIdentity(null);
              try {
                const account = await fetchAccount({
                  apiOrigin: apiOrigin(env),
                  fetchImpl,
                  token: credential.access
                });
                accountId = accountIdentity(account);
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
                source: "apinex-cli"
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
              return { type: "failed", error: safeErrorMessage(error, []) };
            }
          }
        },
        {
          type: "api",
          label: "APInex Access Token（无本地登录态时手动填入）",
          placeholder: "APInex access token"
        }
      ],

      async refresh(auth) {
        return refreshAccount(auth);
      },

      async usage(getAuth) {
        try {
          const { token } = await tokenFor(getAuth);
          if (!token) return { error: "not signed in", windows: [] };
          const fetched = await fetchAccount({ apiOrigin: apiOrigin(env), fetchImpl, token });
          return accountUsage(fetched?.account ?? fetched);
        } catch (error) {
          return {
            error: safeErrorMessage(error, []),
            ...(error?.signIn === "expired" ? { signIn: "expired" } : {}),
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
            if (!resolved.token) throw new Error("APInex is not signed in. Run `apinex login` first.");

            const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.delete("x-magpie-session");
            for (const [name, value] of Object.entries(cliHeaders())) headers.set(name, value);
            headers.set("Authorization", `Bearer ${resolved.token}`);

            let nextInit = { ...init, headers };
            if (isChatRequest(input)) {
              headers.set("Content-Type", "application/json");
              headers.set("Accept", "text/event-stream");
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

export const ApinexPlugin = async ({ client } = {}) => {
  void client;
  return createApiNexPlugin();
};

export default ApinexPlugin;
export const _internal = {
  shapeChatPayload,
  toApinexModel,
  accountUsage,
  apiOrigin,
  cliHeaders
};
