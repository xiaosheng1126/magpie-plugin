import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const MODEL_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LOCK_STALE_MS = 45_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 20_000;

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function userHome(env = process.env, explicitHome) {
  return explicitHome || env.HOME || homedir();
}

export function configHome(env = process.env, explicitHome) {
  return env.XDG_CONFIG_HOME || path.join(userHome(env, explicitHome), ".config");
}

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function apinexPaths({ env = process.env, homeDir, platform = process.platform } = {}) {
  const p = platformPath(platform);
  const dir = platform === "win32"
    ? p.join(env.APPDATA || p.join(userHome(env, homeDir), "AppData", "Roaming"), "apinex")
    : p.join(env.XDG_CONFIG_HOME || p.join(userHome(env, homeDir), ".config"), "apinex");

  return {
    dir,
    authFile: p.join(dir, "auth.json"),
    configFile: p.join(dir, "config.json"),
    modelsFile: p.join(dir, "models.json"),
    lockFile: p.join(dir, "auth.refresh.lock")
  };
}

export function dlConfigCandidates({ env = process.env, homeDir, platform = process.platform } = {}) {
  const p = platformPath(platform);
  const root = env.XDG_CONFIG_HOME || p.join(userHome(env, homeDir), ".config");
  return [
    p.join(root, "autopilot", "config.json"),
    p.join(root, "kimiflare", "config.json")
  ];
}

export function resolveDlConfigPath(options = {}) {
  const [preferred, legacy] = dlConfigCandidates(options);
  return existsSync(preferred) ? preferred : existsSync(legacy) ? legacy : preferred;
}

export function dlPaths(options = {}) {
  const configFile = resolveDlConfigPath(options);
  return {
    configFile,
    lockFile: `${configFile}.refresh.lock`
  };
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // A directory already owned with restrictive permissions is still usable.
    }
  }
}

export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd;

  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") {
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // The file was created with 0600; chmod is a best-effort hardening step.
      }
    }
    renameSync(tmp, file);
    if (process.platform !== "win32") {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort on filesystems that do not support POSIX modes.
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore a close error while preserving the original write failure.
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ignore temporary-file cleanup failures.
    }
    throw error;
  }
}

export function timeoutSignal(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal;
}

export async function fetchWithTimeout(fetchImpl, input, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchImpl(input, {
    ...init,
    signal: timeoutSignal(init.signal, timeoutMs)
  });
}

export function describeNetworkError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const detail = [
    code,
    cause?.message && cause.message !== error?.message ? cause.message : ""
  ].filter(Boolean).join(": ");
  const message = error?.message || String(error);
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

export function redactSecrets(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:access|refresh)_token"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
}

export function safeErrorMessage(error, secrets = []) {
  return redactSecrets(describeNetworkError(error), secrets);
}

export function parseContextTokens(value, fallback = 128_000) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim().toUpperCase();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  if (text.endsWith("M")) return Math.round(number * 1_000_000);
  if (text.endsWith("K")) return Math.round(number * 1_000);
  return Math.round(number);
}

export function finitePrice(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function toProviderModel({
  id,
  name,
  context = 128_000,
  output = 8_192,
  reasoning = false,
  toolCall = false,
  vision = false,
  input = 0,
  outputPrice = input,
  free = false,
  unavailable = false
}) {
  return {
    id,
    name: name || id,
    free,
    rate: free ? 0 : input,
    limit: {
      context,
      output
    },
    reasoning,
    tool_call: toolCall,
    ...(unavailable ? { unavailable: true } : {}),
    cost: {
      input: free ? 0 : input,
      output: free ? 0 : outputPrice,
      cache_read: 0,
      cache_write: 0
    },
    capabilities: {
      reasoning,
      toolcall: toolCall,
      input: {
        text: true,
        ...(vision ? { image: true } : {})
      },
      output: {
        text: true
      }
    }
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function removeStaleLock(lockFile, now, staleMs) {
  try {
    const stat = statSync(lockFile);
    if (now() - stat.mtimeMs > staleMs) {
      rmSync(lockFile, { force: true });
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

export async function withFileLock(lockFile, fn, {
  now = Date.now,
  sleep = defaultSleep,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS
} = {}) {
  ensurePrivateDir(path.dirname(lockFile));
  const owner = `${process.pid}:${randomBytes(12).toString("hex")}`;
  const deadline = now() + timeoutMs;
  let fd;

  while (fd === undefined) {
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleLock(lockFile, now, staleMs)) continue;
      if (now() >= deadline) throw new Error("Timed out waiting for the credential refresh lock");
      await sleep(50);
    }
  }

  try {
    writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, createdAt: now() }), "utf8");
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore close failures during cleanup.
    }
    try {
      const current = readJsonFile(lockFile, null);
      if (current?.owner === owner) rmSync(lockFile, { force: true });
    } catch {
      // Never remove a lock owned by another process.
    }
  }
}

export function toModelMap(models) {
  return Object.fromEntries(models.map((model) => [model.id, model]));
}
