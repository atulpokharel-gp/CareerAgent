# Career-Ops Realtime Web

Production-oriented, session-based web layer for career-ops with no account system.

## What this app provides

- Multi-user, session-isolated pipeline (no persistent login)
- Bring-your-own AI key model (OpenAI, Anthropic, Gemini, OpenRouter)
- Real-time server stream (SSE) for scan progress and job discoveries
- Modern animated UI for CV, skills, goals, and live shortlist
- Ephemeral context retention with auto-expiry TTL
- Autonomous scheduler mode (scan, rank, and draft application packets on interval)

## Security model

- No database required for MVP
- Session context stored in memory only with expiry
- API keys accepted per session and never written to disk
- Session destroy endpoint for immediate purge

Distributed mode now uses Redis for shared session state and pub/sub fanout across API replicas.

## Run locally

From repository root:

```bash
npm run web:install
npm run web:dev
```

- API server: http://localhost:8787
- Frontend: http://localhost:5173

Before running server in distributed mode, start Redis and set `REDIS_URL`.

## Build

```bash
npm run web:build
npm run web:start
```

## Production deployment pattern

Recommended split for traffic-heavy workloads:

1. Frontend on static host/CDN
- Cloudflare Pages, Vercel, or Netlify.

2. API on horizontally scaled containers
- Fly.io, Render, Railway, AWS ECS/Fargate, or Kubernetes.

3. Session + queue externalization (next step)
- Session store is Redis-backed.
- SSE fanout is Redis pub/sub-backed.
- Add global distributed rate limits.

4. Traffic controls
- Put CDN/WAF in front.
- Enable per-IP and per-session request ceilings.
- Cap concurrent scans and queue depth.

5. Reliability
- Health checks at /healthz
- Structured logs via Fastify logger
- Add OpenTelemetry + metrics exporter in next iteration

## LinkedIn automation policy

This implementation supports no-touch autonomous scanning, ranking, and drafting.

Final application submission remains blocked by policy-safe guardrails, especially for LinkedIn flows where anti-bot controls and account-risk constraints apply.

## Environment variables

Server (`apps/realtime-web/server`):

- `PORT` (default `8787`)
- `HOST` (default `0.0.0.0`)
- `CORS_ORIGIN` (default `*`)
- `SESSION_TTL_MS` (default `21600000`, 6h)
- `MAX_SESSIONS` (default `5000`)
- `GLOBAL_CONCURRENT_SCANS` (default `20`)
- `REDIS_URL` (default `redis://127.0.0.1:6379`)
- `REDIS_KEY_PREFIX` (default `career-ops:realtime`)

Client (`apps/realtime-web/client`):

- `VITE_API_BASE` (default `http://localhost:8787`)
