import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MODEL_TTL_MS, apinexPaths, readJsonFile, writeJsonAtomic } from "../shared/core.mjs";
import { _internal, createApiNexPlugin } from "../plugins/apinex/index.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installAuth(root, auth) {
  const paths = apinexPaths({ homeDir: root, env: {}, platform: "darwin" });
  writeJsonAtomic(paths.authFile, auth);
  return paths;
}

function oauthAuth({ access, refresh, expires, accountId = "account" }) {
  return { type: "oauth", access, refresh, expires, accountId, uid: accountId };
}

test("APInex chat uses the request account's OAuth token and matches the CLI body", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-chat-"));
  const now = 1_000_000;
  installAuth(root, {
    accessToken: "cli-other-account",
    refreshToken: "cli-other-refresh",
    expiresAt: now + 3_600_000
  });
  const account = oauthAuth({
    access: "access-account-a",
    refresh: "refresh-account-a",
    expires: now + 3_600_000,
    accountId: "a@example.com"
  });
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(429, { error: { message: "rate limited" } });
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  const tools = [{ type: "function", function: { name: "lookup" } }];
  const response = await loader.fetch("https://api.apinex.bond/v1/chat/completions", {
    method: "POST",
    headers: { "X-Magpie-Session": "internal-session" },
    body: JSON.stringify({
      model: "free/kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      temperature: 0.9,
      tools
    })
  });

  assert.equal(response.status, 429);
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer access-account-a");
  assert.equal(headers.get("user-agent"), "APInex-CLI/1.0.8");
  assert.equal(headers.get("src"), "apinexcli");
  assert.equal(headers.get("x-apinex-src"), "apinexcli");
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("x-magpie-session"), null);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "free/kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
    src: "apinexcli",
    tools
  });
  assert.equal(plugin.auth.rotating, true);
  assert.equal(plugin.auth.maxConcurrency, 1);
  assert.equal(plugin.auth.refreshLead, 30_000);
});

test("APInex keeps two OAuth accounts isolated while each loader runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-accounts-"));
  const now = 1_500_000;
  const paths = installAuth(root, {
    accessToken: "cli-account-a",
    refreshToken: "cli-refresh-a",
    expiresAt: now + 3_600_000
  });
  const accountA = oauthAuth({ access: "cli-account-a", refresh: "cli-refresh-a", expires: now + 3_600_000, accountId: "a" });
  const accountB = oauthAuth({ access: "account-b-access", refresh: "account-b-refresh", expires: now + 3_600_000, accountId: "b" });
  const authorization = [];
  const fetchImpl = async (input, init) => {
    authorization.push(new Headers(init.headers).get("authorization"));
    return jsonResponse(429, { error: "rate limited" });
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const loaderA = await plugin.auth.loader(async () => accountA);
  const loaderB = await plugin.auth.loader(async () => accountB);
  const request = (loader, text) => loader.fetch("https://api.apinex.bond/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "free/kimi-k3", messages: [{ role: "user", content: text }] })
  });

  assert.equal((await request(loaderA, "a")).status, 429);
  assert.equal((await request(loaderB, "b")).status, 429);
  assert.deepEqual(authorization, ["Bearer cli-account-a", "Bearer account-b-access"]);
  assert.equal(readJsonFile(paths.authFile).accessToken, "cli-account-a");
});

test("APInex usage maps subscription quota, balance and the free access fallback", () => {
  const subscriptionUsage = _internal.accountUsage({
    user: { email: "andy@example.com" },
    balanceUsd: 1.2345,
    subscription: {
      label: "PRO",
      tokenLimit: 2_000_000,
      tokensUsed: 500_000,
      unlimited: false,
      resetsAt: "2026-11-20T00:00:00.000Z"
    },
    access: {
      planLabel: "FREE",
      limit: 100,
      used: 100
    }
  });
  assert.equal(subscriptionUsage.plan, "PRO");
  assert.equal(subscriptionUsage.user, "andy@example.com");
  assert.deepEqual(subscriptionUsage.windows, [
    {
      name: "PRO token allowance",
      used: 25,
      display: "500,000 / 2,000,000 tokens used",
      resetsAt: "2026-11-20T00:00:00.000Z"
    },
    { name: "USD balance", used: 0, display: "$1.23" }
  ]);

  const freeUsage = _internal.accountUsage({
    user: { email: "free@example.com" },
    balanceUsd: 0,
    access: {
      planLabel: "FREE",
      limit: 1_000_000,
      used: 250_000,
      resetsAt: "2026-11-21T00:00:00.000Z"
    }
  });
  assert.equal(freeUsage.plan, "FREE");
  assert.equal(freeUsage.windows[0].used, 25);
  assert.equal(freeUsage.windows[0].resetsAt, "2026-11-21T00:00:00.000Z");
  assert.deepEqual(freeUsage.windows[1], { name: "USD balance", used: 0, display: "$0.00" });
});

test("APInex caches models for ten minutes and deduplicates concurrent discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-model-cache-"));
  let now = 1_700_000;
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse(200, {
      models: [{
        id: "free/cache-test",
        name: "Cache Test",
        provider: "Free",
        contextWindow: "1M",
        dollarsPer1M: 0,
        outputDollarsPer1M: 0,
        health: "live"
      }]
    });
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });

  const concurrent = await Promise.all([
    plugin.provider.models({ models: {} }),
    plugin.provider.models({ models: {} })
  ]);
  assert.equal(fetches, 1);
  assert.equal(concurrent[0]["free/cache-test"].free, true);
  assert.equal(concurrent[1]["free/cache-test"].free, true);

  await plugin.provider.models({ models: {} });
  now += MODEL_TTL_MS - 1;
  await plugin.provider.models({ models: {} });
  assert.equal(fetches, 1);

  now += 2;
  await plugin.provider.models({ models: {} });
  assert.equal(fetches, 2);
});

test("APInex hands a 401 to Magpie and refreshes only when auth.refresh is called", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-refresh-401-"));
  const now = 2_000_000;
  const paths = installAuth(root, {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: now + 3_600_000,
    account: { email: "andy@example.com" },
    futureField: "kept"
  });
  let currentAuth = oauthAuth({
    access: "access-old",
    refresh: "refresh-old",
    expires: now + 3_600_000,
    accountId: "andy@example.com"
  });
  let chatCount = 0;
  let refreshCount = 0;
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/oauth/token")) {
      refreshCount += 1;
      return jsonResponse(200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600
      });
    }
    chatCount += 1;
    const authorization = new Headers(init.headers).get("authorization");
    return authorization === "Bearer access-new"
      ? jsonResponse(200, { ok: true })
      : jsonResponse(401, { error: "expired" });
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const loader = await plugin.auth.loader(async () => currentAuth);
  const request = () => loader.fetch("https://api.apinex.bond/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "free/kimi-k3", messages: [] })
  });

  assert.equal((await request()).status, 401);
  assert.equal(chatCount, 1);
  assert.equal(refreshCount, 0);
  currentAuth = { ...currentAuth, ...(await plugin.auth.refresh(currentAuth)) };
  assert.equal((await request()).status, 200);
  assert.equal(chatCount, 2);
  assert.equal(refreshCount, 1);

  const saved = readJsonFile(paths.authFile);
  assert.equal(saved.accessToken, "access-new");
  assert.equal(saved.refreshToken, "refresh-new");
  assert.equal(saved.futureField, "kept");
  assert.deepEqual(saved.account, { email: "andy@example.com" });
  assert.equal(readFileSync(paths.authFile, "utf8").includes("refresh-old"), false);
});

test("APInex refreshes a non-CLI account without overwriting the CLI account", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-account-refresh-"));
  const now = 2_500_000;
  const paths = installAuth(root, {
    accessToken: "account-a-access",
    refreshToken: "account-a-refresh",
    expiresAt: now + 3_600_000,
    futureField: "kept"
  });
  const accountB = oauthAuth({
    access: "account-b-access",
    refresh: "account-b-refresh",
    expires: now + 1_000,
    accountId: "b"
  });
  let refreshBodies = 0;
  const fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/cli/oauth/token")) {
      refreshBodies += 1;
      assert.deepEqual(JSON.parse(init.body), {
        grant_type: "refresh_token",
        client_id: "apinex-cli",
        refresh_token: "account-b-refresh",
        src: "apinexcli"
      });
      return jsonResponse(200, {
        access_token: "account-b-new-access",
        refresh_token: "account-b-new-refresh",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const refreshed = await plugin.auth.refresh(accountB);

  assert.deepEqual(refreshed, {
    access: "account-b-new-access",
    refresh: "account-b-new-refresh",
    expires: now + 3_600_000
  });
  assert.equal(refreshBodies, 1);
  const saved = readJsonFile(paths.authFile);
  assert.equal(saved.accessToken, "account-a-access");
  assert.equal(saved.refreshToken, "account-a-refresh");
  assert.equal(saved.futureField, "kept");
});

test("APInex never overwrites a CLI account that changes during refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-cli-switch-"));
  const now = 2_600_000;
  const paths = installAuth(root, {
    accessToken: "account-a-access",
    refreshToken: "account-a-refresh",
    expiresAt: now + 1_000
  });
  const accountA = oauthAuth({ access: "account-a-access", refresh: "account-a-refresh", expires: now + 1_000 });
  const fetchImpl = async (input) => {
    if (String(input).endsWith("/api/cli/oauth/token")) {
      writeJsonAtomic(paths.authFile, {
        accessToken: "account-c-access",
        refreshToken: "account-c-refresh",
        expiresAt: now + 3_600_000
      });
      return jsonResponse(200, {
        access_token: "account-a-new-access",
        refresh_token: "account-a-new-refresh",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });

  await assert.rejects(() => plugin.auth.refresh(accountA), (error) => error.signIn === "expired");
  const saved = readJsonFile(paths.authFile);
  assert.equal(saved.accessToken, "account-c-access");
  assert.equal(saved.refreshToken, "account-c-refresh");
});

test("APInex refreshes the CLI-matching account once across concurrent renewals", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-concurrent-refresh-"));
  const now = 2_750_000;
  const paths = installAuth(root, {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: now + 1_000
  });
  const account = oauthAuth({ access: "access-old", refresh: "refresh-old", expires: now + 1_000, accountId: "a" });
  let refreshCount = 0;
  const fetchImpl = async (input) => {
    if (String(input).endsWith("/api/cli/oauth/token")) {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600
      });
    }
    return jsonResponse(200, {});
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const [first, second] = await Promise.all([
    plugin.auth.refresh(account),
    plugin.auth.refresh(account)
  ]);

  assert.equal(refreshCount, 1);
  assert.deepEqual(first, second);
  assert.equal(first.access, "access-new");
  assert.equal(readJsonFile(paths.authFile).accessToken, "access-new");
});

test("APInex authorize refreshes inside the 30 second window and returns full OAuth state", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-window-"));
  const now = 3_000_000;
  const paths = installAuth(root, {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: now + 29_999,
    futureField: "kept"
  });
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/oauth/token")) {
      assert.deepEqual(JSON.parse(init.body), {
        grant_type: "refresh_token",
        client_id: "apinex-cli",
        refresh_token: "refresh-old",
        src: "apinexcli"
      });
      return jsonResponse(200, {
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
        account: { email: "andy@example.com" }
      });
    }
    if (url.endsWith("/api/cli/account")) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer access-new");
      return jsonResponse(200, { user: { email: "andy@example.com" }, access: { planLabel: "FREE" } });
    }
    return jsonResponse(404, {});
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const flow = await plugin.auth.methods[0].authorize();
  const result = await flow.callback();

  assert.equal(flow.type, "success");
  assert.equal(flow.key, "access-new");
  assert.deepEqual(result, {
    type: "success",
    access: "access-new",
    refresh: "refresh-new",
    expires: now + 3_600_000,
    accountId: "andy@example.com",
    uid: "andy@example.com",
    metadata: {
      access: "access-new",
      refresh: "refresh-new",
      expires: now + 3_600_000,
      accountId: "andy@example.com",
      uid: "andy@example.com",
      handle: "andy@example.com",
      source: "apinex-cli"
    }
  });
  const saved = readJsonFile(paths.authFile);
  assert.equal(saved.accessToken, "access-new");
  assert.equal(saved.futureField, "kept");
  assert.deepEqual(saved.account, { email: "andy@example.com" });
});

test("APInex authorize keeps local CLI login when remote account probe fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-offline-"));
  const now = 2_000_000;
  const paths = installAuth(root, {
    accessToken: "cli-offline-token",
    refreshToken: "cli-offline-refresh",
    expiresAt: now + 3_600_000
  });
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  const flow = await plugin.auth.methods[0].authorize();
  const result = await flow.callback();

  assert.equal(flow.type, "success");
  assert.equal(flow.key, "cli-offline-token");
  assert.equal(result.type, "success");
  assert.equal(result.access, "cli-offline-token");
  assert.equal(result.refresh, "cli-offline-refresh");
  assert.equal(result.expires, now + 3_600_000);
  assert.equal(result.accountId, "apinex");
  assert.equal(result.uid, "apinex");
  assert.equal(result.metadata.source, "apinex-cli");
  assert.equal(readJsonFile(paths.authFile).accessToken, "cli-offline-token");
});

test("APInex manual API tokens do not trigger OAuth refresh on 401", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-manual-"));
  const account = { type: "api", key: "manual-token" };
  let chatCount = 0;
  let refreshCount = 0;
  const fetchImpl = async (input, init) => {
    if (String(input).endsWith("/api/cli/oauth/token")) refreshCount += 1;
    chatCount += 1;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer manual-token");
    return jsonResponse(401, { error: "expired" });
  };
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, fetchImpl });
  const loader = await plugin.auth.loader(async () => account);

  assert.equal((await loader.fetch("https://api.apinex.bond/v1/chat/completions", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await loader.fetch("https://api.apinex.bond/v1/chat/completions", { method: "POST", body: "{}" })).status, 401);
  assert.equal(chatCount, 2);
  assert.equal(refreshCount, 0);
});

test("APInex unknown model capabilities remain disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-models-"));
  const fetchImpl = async () => jsonResponse(200, {
    models: [{
      id: "free/test-model",
      name: "Test",
      provider: "Free",
      contextWindow: "1M",
      dollarsPer1M: 0,
      outputDollarsPer1M: 0,
      health: "live"
    }]
  });
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => 4_000_000, fetchImpl });
  const models = await plugin.provider.models({ models: {} });
  const model = models["free/test-model"];
  assert.equal(model.reasoning, false);
  assert.equal(model.tool_call, false);
  assert.equal(model.free, true);
  assert.equal(model.limit.context, 1_000_000);
});

test("APInex refresh errors do not leak tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "apinex-redact-"));
  const now = 5_000_000;
  installAuth(root, {
    accessToken: "apinex-access-secret",
    refreshToken: "apinex-refresh-secret",
    expiresAt: now + 1_000
  });
  const fetchImpl = async () => jsonResponse(400, {
    error: "invalid_grant",
    error_description: "apinex-access-secret apinex-refresh-secret"
  });
  const plugin = createApiNexPlugin({ homeDir: root, env: {}, now: () => now, fetchImpl });
  await assert.rejects(
    () => plugin.auth.refresh({
      type: "oauth",
      access: "apinex-access-secret",
      refresh: "apinex-refresh-secret",
      expires: now + 1_000
    }),
    (error) => {
      assert.equal(error.message.includes("apinex-access-secret"), false);
      assert.equal(error.message.includes("apinex-refresh-secret"), false);
      return true;
    }
  );
});
