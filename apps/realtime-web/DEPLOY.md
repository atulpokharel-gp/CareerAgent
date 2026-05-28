# Deploying to Vercel

This app (`apps/realtime-web/`) is fully Vercel-ready.

## Quick Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

## Setup Steps

### 1. Import the repo into Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repo
3. **Set the Root Directory** to `apps/realtime-web`

### 2. Configure Environment Variables

In Vercel → Project → Settings → Environment Variables, add:

| Variable | Value | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` | Required for all AI features |
| `VITE_API_BASE` | *(empty string)* | Leave blank — uses same-origin `/api` |
| `CORS_ORIGIN` | `https://your-app.vercel.app` | Your deployment URL |
| `REDIS_URL` | `memory` | For demo; use Upstash for persistence |

> Optional: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` for additional LLM providers.

### 3. Deploy

Click **Deploy**. Vercel will:
- Run `npm run build:client` (Vite build of the React app)
- Serve the `client/dist` output as static files
- Deploy `api/index.ts` as a serverless function on Node.js 20

All `/api/*` requests are routed to the serverless function via `vercel.json`.

---

## Architecture on Vercel

```
Browser
  │
  ├── Static assets (React app)  ←  client/dist/ (CDN)
  │
  └── /api/*  ──────────────────→  api/index.ts  (Fastify serverless)
                                       │
                                       ├── Sessions: in-memory Map (per container)
                                       ├── Data: /tmp/data/ (ephemeral)
                                       └── Output: /tmp/output/ (ephemeral)
```

## Limitations on Vercel

| Feature | Status | Notes |
|---|---|---|
| CV analysis | ✅ Full | Requires `OPENAI_API_KEY` |
| Job evaluation | ✅ Full | |
| Auto-apply (ATS form fill) | ✅ Full | |
| LaTeX CV generation | ✅ Full | Output stored in `/tmp` |
| SSE live feed | ✅ Supported | Requires Vercel Pro (60 s max); Hobby = 10 s |
| Portal scanning | ⚠️ Disabled | Requires local filesystem (`scan.mjs`). Run locally. |
| Pre-loaded CV | ⚠️ Not available | Upload your own CV via the UI |
| Session persistence | ⚠️ Per-container | Use Upstash Redis (`REDIS_URL=redis://...`) for shared sessions |

## Upstash Redis (optional, recommended for production)

For persistent sessions across Vercel function instances:

1. Create a free Redis at [upstash.com](https://upstash.com)
2. Copy the `REDIS_URL` from Upstash console
3. Set it as an environment variable in Vercel

## Local Development

```bash
cd apps/realtime-web
cp .env.example .env
# fill in OPENAI_API_KEY in .env
npm install
npm run dev          # starts Fastify (8787) + Vite (5173) concurrently
```

The Vite dev server proxies `/api/*` to `http://localhost:8787` automatically.
