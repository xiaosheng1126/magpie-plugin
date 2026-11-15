import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOWTOFIX_BASE_URL,
  HOWTOFIX_ID,
  createHowtofixPlugin
} from "./index.mjs";

function fixtureHome({ auth, credentials, models, cliVersion = "0.7.46" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "howtofix-test-"));
  const agentDir = join(home, ".howtofix", "agent");
  mkdirSync(agentDir, { recursive: true });
  if (auth !== undefined) {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
  }
  if (credentials !== undefined) {
    writeFileSync(join(agentDir, "cli-credentials.json"), JSON.stringify(credentials));
  }
  if (models !== undefined) {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  }
  const cliPackageFile = join(home, "cli-package.json");
  writeFileSync(cliPackageFile, JSON.stringify({ version: cliVersion }));
  return {
    home,
    agentDir,
    authFile: join(agentDir, "auth.json"),
    credentialFile: join(agentDir, "cli-credentials.json"),
    modelsFile: join(agentDir, "models.json"),
    cliPackageFile
  };
}

function futureSeconds(offset = 3600) {
  return Math.floor(Date.now() / 1000) + offset;
}

function freshCredentials(token = "cli-token") {
  return {
    accessToken: token,
    accessExpiresAt: futureSeconds(),
    refreshToken: "refresh-token",
    refreshExpiresAt: futureSeconds(86_400),
    deviceId: "device-id"
  };
}

test("registers the howtofix provider with only the six Grok bootstrap models", async () => {
  const paths = fixtureHome();
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    fetchImpl: async () => {
      throw new Error("configuration must not fetch");
    }
  });
  const cfg = {};
  await plugin.config(cfg);

  assert.equal(HOWTOFIX_ID, "howtofix");
  assert.equal(HOWTOFIX_BASE_URL, "https://api.howtofix.id/v1");
  assert.equal(plugin.provider.id, "howtofix");
  assert.equal(plugin.auth.provider, "howtofix");
  assert.equal(cfg.provider.howtofix.name, "HowToFix");
  assert.equal(cfg.provider.howtofix.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.howtofix.api, HOWTOFIX_BASE_URL);
  assert.deepEqual(Object.keys(cfg.provider.howtofix.models).sort(), [
    "grok-4.5",
    "grok-4.5-liberated-sg",
    "grok-4.6",
    "grok-4.6-liberated-sg",
    "grok-4.7",
    "grok-4.7-liberated-sg"
  ]);
  assert.equal(cfg.provider.howtofix.models["grok-4.7"].limit.context, 500_000);
  assert.equal(cfg.provider.howtofix.models["grok-4.7"].reasoning, true);
  assert.equal(cfg.provider.howtofix.models["grok-4.7-liberated-sg"].limit.context, 128_000);
});

test("authorize reuses a fresh CLI credential after verifying the models endpoint", async () => {
  const paths = fixtureHome({
    auth: { howtofix: { type: "api_key", key: "old-auth-token" } },
    credentials: freshCredentials("fresh-cli-token")
  });
  const calls = [];
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const method = plugin.auth.methods.find((item) => item.type === "oauth");
  const result = await method.authorize();

  assert.equal(result.type, "success");
  assert.equal(result.key, "fresh-cli-token");
  assert.equal(result.metadata.source, "howtofix-cli");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${HOWTOFIX_BASE_URL}/models`);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer fresh-cli-token");
  assert.equal(new Headers(calls[0].init.headers).get("x-howtofix-client"), "CLI (0.7.46)");
});

test("authorize explains how to reconnect when no usable local token exists", async () => {
  const paths = fixtureHome({
    credentials: {
      ...freshCredentials("expired-cli-token"),
      accessExpiresAt: futureSeconds(-60)
    }
  });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    fetchImpl: async () => {
      throw new Error("must not send an expired token");
    }
  });
  const method = plugin.auth.methods.find((item) => item.type === "oauth");
  const result = await method.authorize();

  assert.equal(result.type, "failed");
  assert.match(result.error, /howtofix.*\/connect/i);
  assert.equal(result.error.includes("expired-cli-token"), false);
});

test("model discovery filters non-Grok models and merges CLI model metadata", async () => {
  const paths = fixtureHome({
    credentials: freshCredentials("models-token"),
    models: {
      providers: {
        howtofix: {
          models: [{
            id: "grok-4.7",
            contextWindow: 500_000,
            maxTokens: 500_000,
            reasoning: true,
            input: ["text", "image"],
            plans: ["free", "vip"],
            plan: "free"
          }]
        }
      }
    }
  });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), `${HOWTOFIX_BASE_URL}/models`);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer models-token");
      return new Response(JSON.stringify({
        data: [
          { id: "deepseek-v4.1-flash" },
          { id: "grok-4.7" },
          { id: "grok-9-preview" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const models = await plugin.provider.models(
    { models: { fallback: { id: "fallback" } } },
    {}
  );

  assert.deepEqual(Object.keys(models).sort(), ["grok-4.7", "grok-9-preview"]);
  assert.equal(models["grok-4.7"].limit.context, 500_000);
  assert.equal(models["grok-4.7"].limit.output, 500_000);
  assert.equal(models["grok-4.7"].free, true);
  assert.deepEqual(models["grok-4.7"].plans, ["free", "vip"]);
  assert.deepEqual(models["grok-4.7"].capabilities.input, { text: true, image: true });
  assert.equal(models["grok-9-preview"].limit.context, 128_000);
  assert.equal(models["grok-9-preview"].reasoning, false);
  assert.equal(models["grok-9-preview"].tool_call, true);
});

test("model discovery falls back to the verified Grok list when the gateway fails", async () => {
  const paths = fixtureHome({ credentials: freshCredentials("fallback-token") });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async () => new Response(JSON.stringify({ error: "down" }), { status: 503 })
  });
  const fallback = { id: "existing-fallback" };
  const models = await plugin.provider.models({ models: { fallback } }, {});

  assert.deepEqual(models, { fallback });
});

test("loader re-reads the newest fresh credential and preserves the request body", async () => {
  const paths = fixtureHome({
    auth: { howtofix: { type: "api_key", key: "initial-auth-token" } }
  });
  const calls = [];
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const loader = await plugin.auth.loader(async () => ({ key: "stored-token" }));
  assert.equal(loader.baseURL, HOWTOFIX_BASE_URL);
  assert.equal(loader.apiKey, "initial-auth-token");

  const payload = {
    model: "grok-4.7",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    reasoning_effort: "high",
    stream: true
  };
  const first = await loader.fetch(`${HOWTOFIX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(first.status, 429);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer initial-auth-token");
  assert.equal(new Headers(calls[0].init.headers).get("x-howtofix-client"), "CLI (0.7.46)");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);

  writeFileSync(paths.credentialFile, JSON.stringify(freshCredentials("renewed-cli-token")));
  const second = await loader.fetch(`${HOWTOFIX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(second.status, 200);
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer renewed-cli-token");
  assert.deepEqual(JSON.parse(calls[1].init.body), payload);
});

test("loader turns a 401 into a reconnect message without exposing the token", async () => {
  const token = "never-log-this-token";
  const paths = fixtureHome({ credentials: freshCredentials(token) });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async () => new Response(JSON.stringify({ error: `rejected ${token}` }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })
  });
  const loader = await plugin.auth.loader(async () => ({}));
  const response = await loader.fetch(`${HOWTOFIX_BASE_URL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "grok-4.7", messages: [] })
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.match(body.error.message, /howtofix.*\/connect/i);
  assert.equal(JSON.stringify(body).includes(token), false);
});

test("loader redacts a token repeated in a network error", async () => {
  const token = "network-secret-token";
  const paths = fixtureHome({ credentials: freshCredentials(token) });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (_input, init) => {
      throw new Error(`network failed: ${new Headers(init.headers).get("authorization")}`);
    }
  });
  const loader = await plugin.auth.loader(async () => ({}));

  await assert.rejects(
    () => loader.fetch(`${HOWTOFIX_BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "grok-4.7", messages: [] })
    }),
    (error) => {
      assert.match(error.message, /HowToFix 请求失败/);
      assert.equal(error.message.includes(token), false);
      return true;
    }
  );
});

test("usage reports the remaining HowToFix USD balance", async () => {
  const token = "balance-token";
  const paths = fixtureHome({ credentials: freshCredentials(token) });
  const calls = [];
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init.headers) });
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({
          data: { quota_display_type: "USD", quota_per_unit: 500000 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({
          hard_limit_usd: 55,
          soft_limit_usd: 55
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/dashboard/billing/usage")) {
        return new Response(JSON.stringify({ total_usage: 688.38 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.equal(usage.plan, "HowToFix CLI · USD");
  assert.equal(usage.user, "HowToFix user");
  assert.equal(usage.signIn, "kept");
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].name, "账户余额");
  assert.equal(usage.windows[0].used, 12.516);
  assert.equal(usage.windows[0].display, "$48.12 可用 · $6.88 已用 / $55.00 总额");
  assert.equal(calls.length, 3);
  assert.equal(
    calls.find((call) => call.url.endsWith("/api/status")).headers.has("authorization"),
    false
  );
  for (const suffix of ["/dashboard/billing/subscription", "/dashboard/billing/usage"]) {
    const call = calls.find((item) => item.url.endsWith(suffix));
    assert.equal(call.headers.get("authorization"), `Bearer ${token}`);
  }
});

test("usage reports an unlimited HowToFix balance without inventing a percentage", async () => {
  const paths = fixtureHome({ credentials: freshCredentials("unlimited-token") });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({ data: { quota_display_type: "USD" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({ hard_limit_usd: 100000000 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ total_usage: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.equal(usage.windows[0].used, 0);
  assert.equal(usage.windows[0].display, "unlimited");
});

test("usage requires a HowToFix login without sending a request", async () => {
  const paths = fixtureHome();
  let calls = 0;
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch without a token");
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.equal(calls, 0);
  assert.equal(usage.signIn, "expired");
  assert.match(usage.error, /howtofix.*\/connect/i);
  assert.deepEqual(usage.windows, []);
});

test("usage turns a billing 401 into reconnect guidance without exposing the token", async () => {
  const token = "expired-billing-token";
  const paths = fixtureHome({ credentials: freshCredentials(token) });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({ data: { quota_display_type: "USD" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({ error: { message: `rejected ${token}` } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ total_usage: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.equal(usage.signIn, "expired");
  assert.match(usage.error, /howtofix.*\/connect/i);
  assert.equal(JSON.stringify(usage).includes(token), false);
  assert.deepEqual(usage.windows, []);
});

test("usage redacts a token repeated in a balance network error", async () => {
  const token = "balance-network-token";
  const paths = fixtureHome({ credentials: freshCredentials(token) });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({ data: { quota_display_type: "USD" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`socket refused ${token}`);
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.match(usage.error, /读取 HowToFix 余额失败/);
  assert.equal(usage.error.includes(token), false);
  assert.match(usage.error, /\[REDACTED\]/);
  assert.deepEqual(usage.windows, []);
});

test("usage does not report a full balance when the used-credit endpoint fails", async () => {
  const paths = fixtureHome({ credentials: freshCredentials("partial-balance-token") });
  const plugin = createHowtofixPlugin({
    env: {},
    homeDir: paths.home,
    cliPackageFile: paths.cliPackageFile,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify({ data: { quota_display_type: "USD" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/dashboard/billing/subscription")) {
        return new Response(JSON.stringify({ hard_limit_usd: 55 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ error: "usage unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const usage = await plugin.auth.usage(async () => ({}));

  assert.match(usage.error, /dashboard\/billing\/usage.*503/);
  assert.deepEqual(usage.windows, []);
});
