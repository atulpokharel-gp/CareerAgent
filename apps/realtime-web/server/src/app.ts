/**
 * buildApp() — creates and registers the Fastify instance.
 *
 * Separated from index.ts so it can be imported by both:
 *   • The local dev server (index.ts calls app.listen())
 *   • The Vercel serverless handler (api/index.ts emits requests directly)
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { config, IS_VERCEL } from "./config.js";
import { SessionStore } from "./services/sessionStore.js";
import { ScanRunner } from "./services/scanRunner.js";
import { AutopilotRunner } from "./services/autopilotRunner.js";
import { AutomationScheduler } from "./services/automationScheduler.js";
import { registerSessionRoutes } from "./routes/sessionRoutes.js";
import { registerStreamRoutes } from "./routes/streamRoutes.js";
import { registerLocalRoutes } from "./routes/localRoutes.js";
import { registerApplyRoutes } from "./routes/applyRoutes.js";
import { registerMemoryRoutes } from "./routes/memoryRoutes.js";
import { registerWorkflowRoutes } from "./routes/workflowRoutes.js";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    sessionStore: SessionStore;
    scanRunner: ScanRunner;
    autopilotRunner: AutopilotRunner;
    automationScheduler: AutomationScheduler;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: IS_VERCEL
      ? false  // Vercel captures stdout automatically
      : { level: process.env.LOG_LEVEL || "info" },
    trustProxy: true,
  });

  const sessionStore = new SessionStore(
    config.sessionTtlMs,
    config.maxSessions,
    config.redisUrl,
    config.redisKeyPrefix,
  );
  await sessionStore.init();

  app.decorate("sessionStore", sessionStore);
  app.decorate("scanRunner", new ScanRunner(config.repoRoot, config.globalConcurrentScans));
  app.decorate("autopilotRunner", new AutopilotRunner());
  app.decorate("automationScheduler", new AutomationScheduler());

  app.addHook("onClose", async () => {
    app.automationScheduler.stopAll();
    await app.sessionStore.close();
  });

  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });

  await app.register(sensible);

  // Skip rate-limiting on Vercel (handled at the CDN / edge layer)
  if (!IS_VERCEL) {
    await app.register(rateLimit, {
      max: 200,
      timeWindow: "1 minute",
    });
  }

  await registerSessionRoutes(app);
  await registerStreamRoutes(app);
  await registerLocalRoutes(app);
  await registerApplyRoutes(app);
  await registerMemoryRoutes(app);
  await registerWorkflowRoutes(app);

  app.get("/healthz", async () => ({ ok: true, ts: Date.now(), env: IS_VERCEL ? "vercel" : "local" }));

  await app.ready();
  return app;
}
