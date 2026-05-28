/**
 * Vercel Serverless Function — wraps the Fastify app as a Node.js handler.
 *
 * Vercel's Node.js runtime invokes this file for every request to /api/*.
 * We warm the app once per Lambda container, then re-use it across requests.
 *
 * Notes:
 *  - /tmp is the only writable dir (512 MB, ephemeral per container).
 *  - In-memory sessions are scoped to a single container instance.
 *    Set REDIS_URL (e.g. Upstash) for cross-instance session sharing.
 *  - SSE streaming works on Vercel Pro (maxDuration: 60 s).
 *    Hobby plan is limited to 10 s — SSE connections will time out.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { FastifyInstance } from "fastify";
import http from "node:http";

let _app: FastifyInstance | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!_app) {
    // Dynamic import: avoids eager loading on cold starts that don't need the app
    const { buildApp } = await import("../server/src/app.js");
    _app = await buildApp();
  }
  return _app;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const app = await getApp();
  // Delegate the raw Node.js request/response to Fastify
  app.server.emit("request", req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
}

// Tell Vercel NOT to parse the body — Fastify handles it
export const config = {
  api: { bodyParser: false },
};
