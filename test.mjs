import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLIXAD_ID, createClixadPlugin } from "./index.mjs";

test("registers the clixad provider with bootstrap models", async () => {
  const plugin = createClixadPlugin({ env: {}, fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const cfg = {};
  await plugin.config(cfg);

  assert.equal(CLIXAD_ID, "clixad");
  assert.equal(plugin.provider.id, "clixad");
  assert.equal(plugin.auth.provider, "clixad");
  assert.equal(cfg.provider.clixad.name, "Clixad");
  assert.equal(cfg.provider.clixad.npm, "@ai-sdk/openai-compatible");
  assert.ok(Object.keys(cfg.provider.clixad.models).length > 0);
  assert.equal(cfg.provider.clixad.models["gemini-2.5-flash-lite"].tool_call, true);
});

function tempConfig(value) {
  const root = mkdtempSync(join(tmpdir(), "clixad-test-"));
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("reuses the token bound to the CLI login gateway", async () => {
  const configFile = tempConfig({
    token: "cli-token",
    tokenGateway: "https://clixad.onrender.com",
    gatewayUrl: "https://clixad.onrender.com",
    userId: "user-1",
    email: "andy@example.com"
  });
  const plugin = createClixadPlugin({
    env: {},
    configFile,
    fetchImpl: async () => { throw new Error("authorize should not need the network"); }
  });
  const method = plugin.auth.methods.find((item) => item.type === "oauth");
  const result = await method.authorize();

  assert.equal(result.type, "success");
  assert.equal(result.key, "cli-token");
  assert.deepEqual(result.metadata, {
    gatewayUrl: "https://clixad.onrender.com",
    source: "clixad-cli",
    email: "andy@example.com",
    userId: "user-1"
  });
});

test("refuses a local token when the configured gateway differs from tokenGateway", async () => {
  const configFile = tempConfig({
    token: "do-not-leak-this-token",
    tokenGateway: "https://clixad.onrender.com",
    gatewayUrl: "https://clixad.onrender.com"
  });
  const plugin = createClixadPlugin({
    env: { CLIXAD_GATEWAY_URL: "https://other.example" },
    configFile,
    fetchImpl: async () => { throw new Error("must not send the token"); }
  });
  const method = plugin.auth.methods.find((item) => item.type === "oauth");
  const result = await method.authorize();

  assert.equal(result.type, "failed");
  assert.match(result.error, /gateway|网关/i);
  assert.match(result.error, /clixad login/i);
  assert.equal(result.error.includes("do-not-leak-this-token"), false);
});

test("maps live model fields and shows the wallet's free turns", async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer account-token");
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "free-model",
          label: "Free Model",
          context_window: 200_000,
          credits_per_mtoken_input: 12,
          credits_per_mtoken_output: 34,
          est_credits_per_task: 56,
          est_ads_per_task: 2,
          free: true,
          access: "budget",
          efforts: ["low", "high"],
          default_effort: "low"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/v1/wallet?premium=1")) {
      return new Response(JSON.stringify({
        free_tier: { turns_left: 7 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const plugin = createClixadPlugin({ env: {}, fetchImpl });
  const models = await plugin.provider.models(
    { models: { fallback: { id: "fallback" } } },
    { auth: { key: "account-token", metadata: { gatewayUrl: "https://auth.example" } } }
  );

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith("https://auth.example/v1/")));
  assert.equal(models["free-model"].name, "Free Model · 免费 · 7 回合");
  assert.equal(models["free-model"].limit.context, 200_000);
  assert.equal(models["free-model"].rate, 12);
  assert.equal(models["free-model"].reasoning, true);
  assert.equal(models["free-model"].tool_call, true);
  assert.deepEqual(models["free-model"].efforts, ["low", "high"]);
  assert.equal(models["free-model"].default_effort, "low");
  assert.deepEqual(models["free-model"].credits, {
    inputPerMtoken: 12,
    outputPerMtoken: 34,
    estimatePerTask: 56,
    adsPerTask: 2
  });
  assert.equal(models["free-model"].capabilities.input.image, undefined);
});

test("falls back to bootstrap models when model discovery fails", async () => {
  const plugin = createClixadPlugin({
    env: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const fallback = { fallback: { id: "fallback" } };
  const models = await plugin.provider.models(
    { models: fallback },
    { auth: { key: "account-token", metadata: { gatewayUrl: "https://auth.example" } } }
  );
  assert.equal(models, fallback);
});

test("usage reports free credits, budget, premium, and the next UTC reset", async () => {
  const now = Date.UTC(2026, 10, 15, 12, 34, 56);
  const plugin = createClixadPlugin({
    env: {},
    now: () => now,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://auth.example/v1/wallet?premium=1");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer account-token");
      return new Response(JSON.stringify({
        balance: 150,
        free_tier: {
          daily_credits: 100,
          extra_credits: 20,
          credits_left: 70,
          turns_left: 3
        },
        spendable: { budget: 80, premium: 500, budget_after_reset: 100 },
        premium: { unlocked: true, credits: 500 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const usage = await plugin.auth.usage(async () => ({
    key: "account-token",
    metadata: { gatewayUrl: "https://auth.example", email: "andy@example.com" }
  }));

  assert.equal(usage.user, "andy@example.com");
  assert.match(usage.plan, /Clixad/i);
  const daily = usage.windows.find((window) => window.name.includes("每日免费额度"));
  assert.equal(daily.used, 30);
  assert.match(daily.display, /70 \/ 100 credits/);
  assert.match(daily.display, /3 回合/);
  assert.equal(daily.resetsAt, "2026-11-16T00:00:00.000Z");
  const budget = usage.windows.find((window) => window.name.includes("Budget"));
  assert.match(budget.display, /80 credits/);
  const premium = usage.windows.find((window) => window.name.includes("Premium"));
  assert.match(premium.display, /500/);
  assert.match(premium.display, /已解锁/);
});

test("usage marks a 401 as expired and never exposes the token", async () => {
  const plugin = createClixadPlugin({
    env: {},
    fetchImpl: async () => new Response(JSON.stringify({ error: "expired" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })
  });
  const usage = await plugin.auth.usage(async () => ({
    key: "usage-secret-token",
    metadata: { gatewayUrl: "https://auth.example" }
  }));

  assert.equal(usage.signIn, "expired");
  assert.match(usage.error, /clixad login/i);
  assert.equal(JSON.stringify(usage).includes("usage-secret-token"), false);
});

test("usage redacts a token repeated in a network error", async () => {
  const plugin = createClixadPlugin({
    env: {},
    fetchImpl: async (_input, init) => {
      throw new Error(`upstream rejected ${new Headers(init.headers).get("authorization")}`);
    }
  });
  const usage = await plugin.auth.usage(async () => ({
    key: "network-secret-token",
    metadata: { gatewayUrl: "https://auth.example" }
  }));

  assert.match(usage.error, /额度/);
  assert.equal(JSON.stringify(usage).includes("network-secret-token"), false);
});

test("loader re-reads the current auth for every chat request and follows its gateway", async () => {
  let auth = {
    key: "first-account-token",
    metadata: { gatewayUrl: "https://first.example" }
  };
  const calls = [];
  const plugin = createClixadPlugin({
    env: {},
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      const authorization = new Headers(init.headers).get("authorization");
      if (calls.length === 1) {
        assert.equal(authorization, "Bearer first-account-token");
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" }
        });
      }
      assert.equal(authorization, "Bearer second-account-token");
      return new Response(JSON.stringify({ error: "expired" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const loader = await plugin.auth.loader(async () => auth);
  assert.equal(loader.baseURL, "https://first.example/v1");
  assert.equal(loader.apiKey, "first-account-token");

  const payload = {
    model: "free-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    reasoning_effort: "low"
  };
  const first = await loader.fetch("https://first.example/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  assert.equal(first.status, 429);
  assert.deepEqual(JSON.parse(calls[0].init.body), { ...payload, stream: false });

  auth = {
    key: "second-account-token",
    metadata: { gatewayUrl: "https://second.example" }
  };
  const second = await loader.fetch("https://first.example/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ ...payload, stream: true, reasoning_effort: "high" })
  });

  assert.equal(second.status, 401);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://second.example/v1/chat/completions");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    ...payload,
    stream: true,
    reasoning_effort: "high"
  });
});

test("loader redacts a token repeated in a fetch error", async () => {
  const token = "loader-secret-token";
  const plugin = createClixadPlugin({
    env: {},
    fetchImpl: async (_input, init) => {
      throw new Error(`network failed: ${new Headers(init.headers).get("authorization")}`);
    }
  });
  const loader = await plugin.auth.loader(async () => ({
    key: token,
    metadata: { gatewayUrl: "https://auth.example" }
  }));

  await assert.rejects(
    () => loader.fetch("https://auth.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "free-model", messages: [] })
    }),
    (error) => {
      assert.match(error.message, /请求失败/);
      assert.equal(error.message.includes(token), false);
      return true;
    }
  );
});
