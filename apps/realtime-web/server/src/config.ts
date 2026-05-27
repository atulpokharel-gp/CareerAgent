import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env for local development (no external deps needed)
try {
  const envPath = path.resolve(__dirname, "../.env");
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env file, use existing env vars */ }

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6),
  maxSessions: Number(process.env.MAX_SESSIONS || 5000),
  globalConcurrentScans: Number(process.env.GLOBAL_CONCURRENT_SCANS || 20),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || "career-ops:realtime",
  repoRoot: path.resolve(__dirname, "../../../../"),
};
