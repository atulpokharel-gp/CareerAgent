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

/** True when running inside a Vercel serverless function */
export const IS_VERCEL = !!process.env.VERCEL;

// On Vercel: /tmp is the only writable directory (ephemeral, 512 MB).
// Locally:   paths are relative to the monorepo root.
const _repoRoot = IS_VERCEL ? "/tmp" : path.resolve(__dirname, "../../../../");

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6),
  maxSessions: Number(process.env.MAX_SESSIONS || 5000),
  globalConcurrentScans: Number(process.env.GLOBAL_CONCURRENT_SCANS || 20),
  // Default to memory store; set REDIS_URL (e.g. Upstash) for persistent sessions on Vercel
  redisUrl: process.env.REDIS_URL || "memory",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || "career-ops:realtime",
  repoRoot: _repoRoot,
  /** Writable data directory — /tmp/data on Vercel, local data/ otherwise */
  dataDir: IS_VERCEL
    ? "/tmp/data"
    : path.resolve(__dirname, "../../../../apps/realtime-web/data"),
  /** Writable output directory for generated CVs */
  outputDir: IS_VERCEL
    ? "/tmp/output"
    : path.resolve(__dirname, "../../../../apps/realtime-web/output"),
  /** Path to pre-loaded CV PDF; null on Vercel (users upload their own) */
  cvPdfPath: IS_VERCEL
    ? null
    : path.resolve(__dirname, "../../../../cv/startup_v4.pdf"),
};
