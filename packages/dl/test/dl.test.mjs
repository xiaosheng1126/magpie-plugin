import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJsonFile, writeJsonAtomic } from "../shared/core.mjs";
import { createDlPlugin, DL_MODELS } from "../plugins/dl/index.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function configFile(root) {
  return join(root, ".config", "autopilot", "config.json");
}

function oauthAuth({ access, refresh, expires, accountId = "dl-account" }) {
  return { type: "oauth", access, refresh, expires, accountId, uid: accountId };
}

test("dl chat uses the request account's OAuth token and matches the official CLI body", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-chat-"));
  const file = configFile(root);
  const now = 1_000_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "cli-other-account",
        refreshToken: "cli-other-refresh",
        expiresAt: now + 3_600_000
      }
    }
  });
  const account = oauthAuth({ access: "dl-account-token", refresh: "dl-account-refresh", expires: now + 3_600_000 });
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(429, { error: { message: "rate limited" } });
  };
  const plugin = createDlPlugin({
    configFile: file,
    env: {},
    now: () => now,
    fetchImpl,
    randomUUIDImpl: () => "request-fixed"
  });
  const loader = await plugin.auth.loader(async () => account);
  const tools = [{ type: "function", function: { name: "lookup" } }];
  const response = await loader.fetch("https://free.directionallylocal.com/v1/chat/completions", {
    method: "POST",
    headers: { "X-Magpie-Session": "session-123" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hello" }],
      tools,
      temperature: 0.9,
      max_completion_tokens: 10,
      reasoning_effort: "high"
    })
  });

  assert.equal(response.status, 429);
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer dl-account-token");
  assert.equal(headers.get("user-agent"), "autopilot/3.22.0 (+https://github.com/directionally-local/autopilot)");
  assert.equal(headers.get("x-session-id"), "session-123");
  assert.equal(headers.get("x-request-id"), "request-fixed");
  assert.equal(headers.get("x-magpie-session"), null);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    temperature: 0.2,
    max_tokens: 16_384,
    stream_options: { include_usage: true }
  });
  assert.equal(plugin.auth.rotating, true);
  assert.equal(plugin.auth.maxConcurrency, 1);
  assert.equal(plugin.auth.refreshLead, 60_000);
});

test("dl chat omits tool fields when no tools are supplied", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-chat-no-tools-"));
  const file = configFile(root);
  const now = 1_250_000;
  const account = oauthAuth({ access: "dl-account-token", refresh: "dl-account-refresh", expires: now + 3_600_000 });
  let body;
  const fetchImpl = async (input, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(429, { error: "rate limited" });
  };
  const plugin = createDlPlugin({
    configFile: file,
    env: {},
    now: () => now,
    fetchImpl,
    randomUUIDImpl: () => "request-no-tools"
  });
  const loader = await plugin.auth.loader(async () => account);
  const response = await loader.fetch("https://free.directionallylocal.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
  });

  assert.equal(response.status, 429);
  assert.deepEqual(body, {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    temperature: 0.2,
    max_tokens: 16_384,
    stream_options: { include_usage: true }
  });
});

test("dl usage maps weekly, pool, budget, top-up, referral and queue balances", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-usage-"));
  const file = configFile(root);
  const now = 1_300_000;
  const account = oauthAuth({ access: "dl-usage-token", refresh: "dl-usage-refresh", expires: now + 3_600_000 });
  const resetsAt = "2026-11-16T00:00:00.000Z";
  const fetchImpl = async (input, init) => {
    assert.equal(String(input).endsWith("/v1/me"), true);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer dl-usage-token");
    return jsonResponse(200, {
      login: "andy",
      plan: "free",
      level: "full",
      allowance: {
        tokensPerWeek: 50_000_000,
        usedThisWeek: 4_000_000,
        remaining: 46_000_000,
        usdPerWeek: 20,
        spentUsdThisWeek: 5,
        resetsAt
      },
      pools: {
        luna: {
          tokensPerWeek: 30_000_000,
          usedThisWeek: 3_000_000,
          remaining: 27_000_000,
          resetsAt
        }
      },
      budgets: {
        gpt6: { usdPerWeek: 10, spentUsd: 2.5, tokensThisWeek: 1_000_000 },
        deepseek: { usdPerWeek: null, spentUsd: 1.25, tokensThisWeek: 250_000 }
      },
      topupTokensLeft: 1_500_000,
      topupUsdLeft: 2.5,
      topupUsdExpiresAt: "2026-12-01T00:00:00.000Z",
      referral: { bonusTokensPerWeek: 10_000_000 },
      queue: { position: 3, etaAt: "2026-11-15T00:10:00.000Z" }
    });
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const usage = await plugin.auth.usage(async () => account);

  assert.equal(usage.plan, "DL Free · FULL");
  assert.equal(usage.user, "andy");
  assert.equal(usage.signIn, "kept");
  assert.deepEqual(usage.windows, [
    {
      name: "每周免费额度 (Weekly Allowance)",
      used: 8,
      display: "46,000,000 / 50,000,000 tokens 剩余",
      resetsAt
    },
    {
      name: "每周美元额度 (Weekly USD Allowance)",
      used: 25,
      display: "$15.00 / $20.00 剩余",
      resetsAt
    },
    {
      name: "池限额 · LUNA (30M)",
      used: 10,
      display: "27,000,000 / 30,000,000 tokens 剩余",
      resetsAt
    },
    {
      name: "美元预算 · GPT-6",
      used: 25,
      display: "$7.50 / $10.00 剩余",
      resetsAt
    },
    {
      name: "美元预算 · DEEPSEEK",
      used: 0,
      display: "$1.25 used · 无上限",
      resetsAt
    },
    {
      name: "充值 token 余额",
      used: 0,
      display: "1,500,000 tokens"
    },
    {
      name: "充值美元余额",
      used: 0,
      display: "$2.50",
      resetsAt: "2026-12-01T00:00:00.000Z"
    },
    {
      name: "邀请奖励 · 每周",
      used: 0,
      display: "+10,000,000 tokens/周"
    },
    {
      name: "免费额度排队",
      used: 0,
      display: "第 3 位 · 预计 2026-11-15T00:10:00.000Z",
      resetsAt: "2026-11-15T00:10:00.000Z"
    }
  ]);
});

test("dl keeps two OAuth accounts isolated while each loader runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-accounts-"));
  const file = configFile(root);
  const now = 1_500_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "cli-account-a",
        refreshToken: "cli-refresh-a",
        expiresAt: now + 3_600_000
      }
    }
  });
  const accountA = oauthAuth({ access: "cli-account-a", refresh: "cli-refresh-a", expires: now + 3_600_000, accountId: "a" });
  const accountB = oauthAuth({ access: "account-b-access", refresh: "account-b-refresh", expires: now + 3_600_000, accountId: "b" });
  const authorization = [];
  const fetchImpl = async (input, init) => {
    authorization.push(new Headers(init.headers).get("authorization"));
    return jsonResponse(429, { error: "rate limited" });
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const loaderA = await plugin.auth.loader(async () => accountA);
  const loaderB = await plugin.auth.loader(async () => accountB);
  const request = (loader, text) => loader.fetch("https://free.directionallylocal.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: text }] })
  });

  assert.equal((await request(loaderA, "a")).status, 429);
  assert.equal((await request(loaderB, "b")).status, 429);
  assert.deepEqual(authorization, ["Bearer cli-account-a", "Bearer account-b-access"]);
  assert.equal(readJsonFile(file).providers["directionally-local"].apiKey, "cli-account-a");
});

test("dl hands a 401 to Magpie and refreshes only when auth.refresh is called", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-refresh-401-"));
  const file = configFile(root);
  const now = 2_000_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "dl-old",
        refreshToken: "refresh-old",
        expiresAt: now + 3_600_000
      }
    }
  });
  let currentAuth = oauthAuth({ access: "dl-old", refresh: "refresh-old", expires: now + 3_600_000 });
  let chatCount = 0;
  let refreshCount = 0;
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/token/refresh")) {
      refreshCount += 1;
      assert.deepEqual(JSON.parse(init.body), { refresh_token: "refresh-old" });
      return jsonResponse(200, {
        access_token: "dl-new",
        refresh_token: "refresh-new",
        expires_in: 3600
      });
    }
    chatCount += 1;
    const authorization = new Headers(init.headers).get("authorization");
    return authorization === "Bearer dl-new"
      ? jsonResponse(200, { ok: true })
      : jsonResponse(401, { error: "expired" });
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const loader = await plugin.auth.loader(async () => currentAuth);
  const request = () => loader.fetch("https://free.directionallylocal.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-6-luna", messages: [] })
  });

  assert.equal((await request()).status, 401);
  assert.equal(chatCount, 1);
  assert.equal(refreshCount, 0);
  currentAuth = { ...currentAuth, ...(await plugin.auth.refresh(currentAuth)) };
  assert.equal((await request()).status, 200);
  assert.equal(chatCount, 2);
  assert.equal(refreshCount, 1);
});

test("dl refreshes a non-CLI account without overwriting the CLI account", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-account-refresh-"));
  const file = configFile(root);
  const now = 2_500_000;
  writeJsonAtomic(file, {
    unknownTop: 7,
    providers: {
      other: { keep: true },
      "directionally-local": {
        apiKey: "account-a-access",
        refreshToken: "account-a-refresh",
        expiresAt: now + 3_600_000,
        unknownProvider: "kept"
      }
    }
  });
  const accountB = oauthAuth({ access: "account-b-access", refresh: "account-b-refresh", expires: now + 1_000, accountId: "b" });
  let refreshCount = 0;
  const fetchImpl = async (input, init) => {
    if (String(input).endsWith("/v1/token/refresh")) {
      refreshCount += 1;
      assert.deepEqual(JSON.parse(init.body), { refresh_token: "account-b-refresh" });
      return jsonResponse(200, {
        access_token: "account-b-new-access",
        refresh_token: "account-b-new-refresh",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const refreshed = await plugin.auth.refresh(accountB);

  assert.deepEqual(refreshed, {
    access: "account-b-new-access",
    refresh: "account-b-new-refresh",
    expires: now + 3_600_000
  });
  assert.equal(refreshCount, 1);
  const saved = readJsonFile(file);
  assert.equal(saved.unknownTop, 7);
  assert.equal(saved.providers.other.keep, true);
  assert.equal(saved.providers["directionally-local"].apiKey, "account-a-access");
  assert.equal(saved.providers["directionally-local"].refreshToken, "account-a-refresh");
  assert.equal(saved.providers["directionally-local"].unknownProvider, "kept");
});

test("dl never overwrites a CLI account that changes during refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-cli-switch-"));
  const file = configFile(root);
  const now = 2_600_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "account-a-access",
        refreshToken: "account-a-refresh",
        expiresAt: now + 1_000
      }
    }
  });
  const accountA = oauthAuth({ access: "account-a-access", refresh: "account-a-refresh", expires: now + 1_000 });
  const fetchImpl = async (input) => {
    if (String(input).endsWith("/v1/token/refresh")) {
      writeJsonAtomic(file, {
        providers: {
          "directionally-local": {
            apiKey: "account-c-access",
            refreshToken: "account-c-refresh",
            expiresAt: now + 3_600_000
          }
        }
      });
      return jsonResponse(200, {
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });

  await assert.rejects(() => plugin.auth.refresh(accountA), (error) => error.signIn === "expired");
  const saved = readJsonFile(file).providers["directionally-local"];
  assert.equal(saved.apiKey, "account-c-access");
  assert.equal(saved.refreshToken, "account-c-refresh");
});

test("dl refreshes the CLI-matching account once across concurrent renewals", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-concurrent-refresh-"));
  const file = configFile(root);
  const now = 2_750_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "dl-old",
        refreshToken: "refresh-old",
        expiresAt: now + 1_000
      }
    }
  });
  const account = oauthAuth({ access: "dl-old", refresh: "refresh-old", expires: now + 1_000 });
  let refreshCount = 0;
  const fetchImpl = async (input) => {
    if (String(input).endsWith("/v1/token/refresh")) {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, {
        access_token: "dl-new",
        refresh_token: "refresh-new",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const [first, second] = await Promise.all([
    plugin.auth.refresh(account),
    plugin.auth.refresh(account)
  ]);

  assert.equal(refreshCount, 1);
  assert.deepEqual(first, second);
  assert.equal(first.access, "dl-new");
  assert.equal(readJsonFile(file).providers["directionally-local"].apiKey, "dl-new");
});

test("dl authorize refreshes inside the 60 second window and returns full OAuth state", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-window-"));
  const file = configFile(root);
  const now = 3_000_000;
  writeJsonAtomic(file, {
    unknownTop: 7,
    providers: {
      other: { keep: true },
      "directionally-local": {
        apiKey: "dl-old",
        refreshToken: "refresh-old",
        expiresAt: now + 59_999,
        model: "gpt-6-luna",
        unknownProvider: "kept"
      }
    }
  });
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/token/refresh")) {
      assert.deepEqual(JSON.parse(init.body), { refresh_token: "refresh-old" });
      const headers = new Headers(init.headers);
      assert.equal(headers.get("user-agent"), "autopilot/3.22.0 (+https://github.com/directionally-local/autopilot)");
      assert.equal(headers.get("accept"), "application/json");
      return jsonResponse(200, {
        access_token: "dl-new",
        refresh_token: "refresh-new",
        expires_in: 3600
      });
    }
    if (url.endsWith("/v1/me")) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer dl-new");
      return jsonResponse(200, { login: "andy", githubId: "42", allowance: { tokensPerWeek: 50_000_000 } });
    }
    return jsonResponse(404, {});
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const flow = await plugin.auth.methods[0].authorize();
  const result = await flow.callback();

  assert.equal(flow.type, "success");
  assert.equal(flow.key, "dl-new");
  assert.deepEqual(result, {
    type: "success",
    access: "dl-new",
    refresh: "refresh-new",
    expires: now + 3_600_000,
    accountId: "42",
    uid: "42",
    metadata: {
      access: "dl-new",
      refresh: "refresh-new",
      expires: now + 3_600_000,
      accountId: "42",
      uid: "42",
      handle: "42",
      source: "dl-cli"
    }
  });
  assert.equal(calls[0].url.endsWith("/v1/token/refresh"), true);
  const saved = readJsonFile(file);
  assert.equal(saved.unknownTop, 7);
  assert.equal(saved.providers.other.keep, true);
  assert.equal(saved.providers["directionally-local"].apiKey, "dl-new");
  assert.equal(saved.providers["directionally-local"].refreshToken, "refresh-new");
  assert.equal(saved.providers["directionally-local"].unknownProvider, "kept");
});

test("dl authorize keeps local CLI login when remote account probe fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-offline-"));
  const file = configFile(root);
  const now = 2_000_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "cli-offline-token",
        refreshToken: "cli-offline-refresh",
        expiresAt: now + 3_600_000
      }
    }
  });
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  const flow = await plugin.auth.methods[0].authorize();
  const result = await flow.callback();

  assert.equal(flow.type, "success");
  assert.equal(flow.key, "cli-offline-token");
  assert.equal(result.type, "success");
  assert.equal(result.access, "cli-offline-token");
  assert.equal(result.refresh, "cli-offline-refresh");
  assert.equal(result.expires, now + 3_600_000);
  assert.equal(result.accountId, "dl");
  assert.equal(result.uid, "dl");
  assert.equal(result.metadata.source, "dl-cli");
  assert.equal(readJsonFile(file).providers["directionally-local"].apiKey, "cli-offline-token");
});

test("dl manual API tokens do not trigger OAuth refresh on 401", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-manual-"));
  const file = configFile(root);
  const account = { type: "api", key: "manual-token" };
  let chatCount = 0;
  let refreshCount = 0;
  const fetchImpl = async (input, init) => {
    if (String(input).endsWith("/v1/token/refresh")) refreshCount += 1;
    chatCount += 1;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer manual-token");
    return jsonResponse(401, { error: "expired" });
  };
  const plugin = createDlPlugin({ configFile: file, env: {}, fetchImpl });
  const loader = await plugin.auth.loader(async () => account);

  assert.equal((await loader.fetch("https://free.directionallylocal.com/v1/chat/completions", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await loader.fetch("https://free.directionallylocal.com/v1/chat/completions", { method: "POST", body: "{}" })).status, 401);
  assert.equal(chatCount, 2);
  assert.equal(refreshCount, 0);
});

test("dl display name is short while the provider id stays compatible", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-config-"));
  const plugin = createDlPlugin({ configFile: join(root, "config.json"), env: {} });
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider["directionally-local"].name, "DL");
  assert.equal(plugin.provider.id, "directionally-local");
});

test("dl model capabilities come from the official catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-models-"));
  const plugin = createDlPlugin({ configFile: join(root, "config.json"), env: {}, fetchImpl: async () => jsonResponse(200, {}) });
  const models = await plugin.provider.models({ models: {} });
  assert.equal(Object.keys(models).length, DL_MODELS.length);
  assert.equal(models["gpt-6-luna"].tool_call, true);
  assert.equal(models["gpt-6-luna"].capabilities.input.image, true);
  assert.equal(models["deepseek/deepseek-v4.1-flash-1017"].tool_call, true);
  assert.equal(models["deepseek/deepseek-v4.1-flash-1017"].capabilities.input.image, undefined);
});

test("dl refresh errors do not leak tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "dl-redact-"));
  const file = configFile(root);
  const now = 4_000_000;
  writeJsonAtomic(file, {
    providers: {
      "directionally-local": {
        apiKey: "dl-access-secret",
        refreshToken: "dl-refresh-secret",
        expiresAt: now + 1_000
      }
    }
  });
  const fetchImpl = async () => jsonResponse(400, {
    error: "invalid_grant",
    error_description: "dl-access-secret dl-refresh-secret"
  });
  const plugin = createDlPlugin({ configFile: file, env: {}, now: () => now, fetchImpl });
  await assert.rejects(
    () => plugin.auth.refresh({
      type: "oauth",
      access: "dl-access-secret",
      refresh: "dl-refresh-secret",
      expires: now + 1_000
    }),
    (error) => {
      assert.equal(error.message.includes("dl-access-secret"), false);
      assert.equal(error.message.includes("dl-refresh-secret"), false);
      return true;
    }
  );
});
