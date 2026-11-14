import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  apinexPaths,
  dlConfigCandidates,
  parseContextTokens,
  redactSecrets,
  writeJsonAtomic
} from "../shared/core.mjs";

test("APInex uses APPDATA on Windows and XDG on Unix", () => {
  const windows = apinexPaths({
    platform: "win32",
    homeDir: "C:\\Users\\andy",
    env: { APPDATA: "D:\\Config" }
  });
  assert.equal(windows.authFile, "D:\\Config\\apinex\\auth.json");

  const unix = apinexPaths({
    platform: "linux",
    homeDir: "/home/andy",
    env: { XDG_CONFIG_HOME: "/tmp/xdg" }
  });
  assert.equal(unix.authFile, "/tmp/xdg/apinex/auth.json");
});

test("dl resolves the new config path before the legacy kimiflare path", () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-paths-"));
  const [preferred, legacy] = dlConfigCandidates({ homeDir: root, env: {}, platform: "darwin" });
  assert.equal(preferred, join(root, ".config", "autopilot", "config.json"));
  assert.equal(legacy, join(root, ".config", "kimiflare", "config.json"));
});

test("atomic JSON writes use private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-write-"));
  const file = join(root, "nested", "config.json");
  writeJsonAtomic(file, { token: "secret", nested: { kept: true } });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { token: "secret", nested: { kept: true } });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("context and token helpers are conservative and redact secrets", () => {
  assert.equal(parseContextTokens("1M"), 1_000_000);
  assert.equal(parseContextTokens("64K"), 64_000);
  assert.equal(parseContextTokens(null), 128_000);
  const redacted = redactSecrets("Bearer access-secret refresh_token=refresh-secret", ["access-secret", "refresh-secret"]);
  assert.equal(redacted.includes("access-secret"), false);
  assert.equal(redacted.includes("refresh-secret"), false);
});

test("a later writer can preserve unrelated fields by reading first", () => {
  const root = mkdtempSync(join(tmpdir(), "magpie-preserve-"));
  const file = join(root, "config.json");
  writeJsonAtomic(file, { unknownTop: 1, providers: { other: { keep: true } } });
  const current = JSON.parse(readFileSync(file, "utf8"));
  current.providers.dl = { apiKey: "new" };
  writeJsonAtomic(file, current);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.unknownTop, 1);
  assert.equal(saved.providers.other.keep, true);
});
