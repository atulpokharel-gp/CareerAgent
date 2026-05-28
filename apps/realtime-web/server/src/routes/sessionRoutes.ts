import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ProviderKey, UserContext } from "../types.js";
import { validateProviders, listSupportedProviders } from "../services/providerGuard.js";
import { parseCvWithLlm } from "../services/llmCvParser.js";
import { optimizeCvForAts, scoreAts } from "../services/cvAtsOptimizer.js";
import { parseCvTimeline, generateCareerGoals } from "../services/cvTimelineParser.js";
import { generateLatexCv } from "../services/cvLatexGenerator.js";
import { upsertTrackedJobs } from "../services/persistentStorage.js";

const contextSchema = z.object({
  cv: z.string().min(20).max(120_000),
  skills: z.string().min(2).max(30_000),
  goals: z.string().min(2).max(30_000),
  preferredRoles: z.array(z.string().min(2).max(160)).max(25).default([]),
  locations: z.array(z.string().min(2).max(160)).max(25).default([]),
  providers: z.array(z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
  })).max(8).default([]),
});

const runScanSchema = z.object({
  verify: z.boolean().default(false),
  company: z.string().max(160).optional(),
});

const automationSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(2).max(240).default(5),
  maxJobsPerRun: z.number().int().min(1).max(100).default(25),
  autoApplyRequested: z.boolean().default(false),
});

const cvParseSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
  apiKey: z.string().min(12).max(300),
  cvText: z.string().min(20).max(140_000),
});

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const emitPhase = (sessionId: string, phase: "context" | "scan" | "rank" | "draft" | "done", message: string) => {
    void app.sessionStore.emit(sessionId, {
      type: "phase",
      phase,
      message,
      at: Date.now(),
    });
  };

  const runAutopilotCycle = async (sessionId: string, verify: boolean, company?: string) => {
    const leaseMs = 1000 * 60 * 12;
    const locked = await app.sessionStore.tryAcquireAutopilotLease(sessionId, leaseMs);
    if (!locked) {
      return;
    }

    const latest = await app.sessionStore.get(sessionId);
    if (!latest || !latest.context) {
      return;
    }

    emitPhase(sessionId, "scan", "Scanning job sources");

    const result = await app.autopilotRunner.run({
      session: latest,
      verify,
      company,
      logger: app.log,
      onEvent: (event) => {
        void app.sessionStore.emit(sessionId, event);
      },
      scan: async () => app.scanRunner.runScan({
        verify,
        company,
        // Pass CV-extracted roles so the portal scan is driven by the user's
        // actual background, not the static portals.yml title_filter keywords.
        roles: latest.context?.preferredRoles ?? [],
        logger: app.log,
        onEvent: (event) => {
          void app.sessionStore.emit(sessionId, event);
        },
      }),
    });

    emitPhase(sessionId, "rank", "Ranking jobs against profile");
    await app.sessionStore.mergeRankedJobs(sessionId, result.ranked);
    emitPhase(sessionId, "draft", "Preparing application drafts");
    await app.sessionStore.mergeDrafts(sessionId, result.drafts);
    await app.sessionStore.mergeJobs(sessionId, result.ranked);

    // ── Persist all ranked jobs to local DB ────────────────────────────────
    // This is the single source of truth: every job that passes ranking is
    // recorded so (a) it's not shown again in future scans, and (b) the ranker
    // can learn from what the user actually applies to.
    void upsertTrackedJobs(
      result.ranked.map((j) => ({
        url: j.url,
        company: j.company,
        title: j.title,
        location: j.location,
        score: j.score,
        reasons: j.reasons,
        status: "shortlisted" as const,
        scannedAt: Date.now(),
      })),
    );

    emitPhase(sessionId, "done", "Autonomous cycle completed");
  };

  app.post("/api/session", async (_request, reply) => {
    const session = await app.sessionStore.create();
    return reply.send({
      sessionId: session.id,
      expiresAt: session.expiresAt,
      supportedProviders: listSupportedProviders(),
    });
  });

  app.get("/api/session/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    return reply.send({
      sessionId: session.id,
      expiresAt: session.expiresAt,
      linkedinConnected: session.linkedinConnected,
      jobs: session.jobs,
      rankedJobs: session.rankedJobs,
      drafts: session.drafts,
      automation: session.automation,
      hasContext: Boolean(session.context),
      providers: session.providerKeys.map((provider) => provider.provider),
    });
  });

  app.post("/api/session/:sessionId/automation", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const parse = automationSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const session = await app.sessionStore.setAutomation(sessionId, parse.data);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: `Automation ${session.automation.enabled ? "enabled" : "disabled"} (${session.automation.intervalMinutes}m interval)` ,
      at: Date.now(),
    });

    if (!session.automation.enabled) {
      app.automationScheduler.stop(sessionId);
    }

    return reply.send({ ok: true, automation: session.automation });
  });

  app.post("/api/session/:sessionId/context", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const parse = contextSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const parsed = parse.data;
    let providers: ProviderKey[] = [];
    try {
      providers = validateProviders(parsed.providers);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid providers" });
    }

    const context: UserContext = {
      cv: parsed.cv,
      skills: parsed.skills,
      goals: parsed.goals,
      preferredRoles: parsed.preferredRoles,
      locations: parsed.locations,
    };

    const session = await app.sessionStore.setContext(sessionId, context, providers);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: "Context updated",
      at: Date.now(),
    });
    emitPhase(sessionId, "context", "Profile context ready");

    return reply.send({ ok: true, expiresAt: session.expiresAt });
  });

  app.post("/api/session/:sessionId/parse-cv", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    const parse = cvParseSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    try {
      const result = await parseCvWithLlm(parse.data);
      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: "CV parsed successfully with LLM",
        at: Date.now(),
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "CV parsing failed" });
    }
  });

  // ── ATS CV Optimization ──────────────────────────────────────────────────────

  const atsOptimizeSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
    cvText: z.string().min(20).max(140_000),
    targetRoles: z.array(z.string().min(2).max(160)).max(25).default([]),
    jobDescription: z.string().max(8000).optional(),
  });

  const atsScoringSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
    cvText: z.string().min(20).max(140_000),
    targetRoles: z.array(z.string().min(2).max(160)).max(25).default([]),
  });

  /** Full optimize — rewrites CV to 85+ ATS score */
  app.post("/api/session/:sessionId/optimize-cv", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    const parse = atsOptimizeSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const { provider, apiKey, cvText, targetRoles, jobDescription } = parse.data;
    const providerKey: ProviderKey = { provider, apiKey };

    try {
      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: "Optimizing CV for ATS (targeting 85+)...",
        at: Date.now(),
      });

      const result = await optimizeCvForAts(cvText, targetRoles, providerKey, jobDescription);

      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: result.wasOptimized
          ? `ATS score: ${result.originalScore} → ${result.optimizedScore} (+${result.optimizedScore - result.originalScore} pts)`
          : `ATS score already at ${result.originalScore} — no changes needed`,
        at: Date.now(),
      });

      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "ATS optimization failed" });
    }
  });

  /** Quick score — just returns the score without a full rewrite */
  app.post("/api/session/:sessionId/score-cv", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    const parse = atsScoringSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const { provider, apiKey, cvText, targetRoles } = parse.data;
    try {
      const result = await scoreAts(cvText, targetRoles, { provider, apiKey });
      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "ATS scoring failed" });
    }
  });

  // ── Timeline ────────────────────────────────────────────────────────────

  const timelineSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
    cvText: z.string().min(20).max(140_000),
  });

  app.post("/api/session/:sessionId/parse-timeline", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) return reply.notFound("Session not found or expired");

    const parse = timelineSchema.safeParse(request.body || {});
    if (!parse.success) return reply.code(400).send({ error: parse.error.flatten() });

    const { provider, apiKey, cvText } = parse.data;
    try {
      const timeline = await parseCvTimeline(cvText, { provider, apiKey });
      return reply.send(timeline);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "Timeline parsing failed" });
    }
  });

  app.post("/api/session/:sessionId/generate-goals", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) return reply.notFound("Session not found or expired");

    const parse = timelineSchema.safeParse(request.body || {});
    if (!parse.success) return reply.code(400).send({ error: parse.error.flatten() });

    const { provider, apiKey, cvText } = parse.data;
    try {
      const goals = await generateCareerGoals(cvText, { provider, apiKey });
      return reply.send({ goals });
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "Goals generation failed" });
    }
  });

  // ── Per-job ATS ─────────────────────────────────────────────────────

  const jobAtsSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
    cvText: z.string().min(20).max(140_000),
    jobTitle: z.string().max(200).default(""),
    jobDescription: z.string().max(8000).default(""),
    targetRoles: z.array(z.string().min(2).max(160)).max(25).default([]),
  });

  /** Optimize the CV specifically for a single job's description */
  app.post("/api/session/:sessionId/job-ats", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) return reply.notFound("Session not found or expired");

    const parse = jobAtsSchema.safeParse(request.body || {});
    if (!parse.success) return reply.code(400).send({ error: parse.error.flatten() });

    const { provider, apiKey, cvText, jobTitle, jobDescription, targetRoles } = parse.data;
    const roles = targetRoles.length > 0 ? targetRoles : jobTitle ? [jobTitle] : ["Software Engineer"];

    try {
      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: `Optimizing CV for: ${jobTitle}...`,
        at: Date.now(),
      });

      const result = await optimizeCvForAts(cvText, roles, { provider, apiKey }, jobDescription);

      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: `Job ATS score: ${result.originalScore} → ${result.optimizedScore}/100`,
        at: Date.now(),
      });

      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "Job ATS optimization failed" });
    }
  });

  // ── LaTeX CV generator ───────────────────────────────────────────────

  const latexSchema = z.object({
    provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
    apiKey: z.string().min(12).max(300),
    cvText: z.string().min(20).max(140_000),
    targetRole: z.string().max(200).default(""),
    slug: z.string().max(60).optional(),
  });

  app.post("/api/session/:sessionId/generate-latex", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) return reply.notFound("Session not found or expired");

    const parse = latexSchema.safeParse(request.body || {});
    if (!parse.success) return reply.code(400).send({ error: parse.error.flatten() });

    const { provider, apiKey, cvText, targetRole, slug } = parse.data;

    try {
      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: `Generating LaTeX + HTML CV for: ${targetRole || "your profile"}...`,
        at: Date.now(),
      });

      const result = await generateLatexCv(cvText, targetRole, { provider, apiKey }, slug);

      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: "CV files saved — LaTeX (.tex) and print-ready HTML ready for download",
        at: Date.now(),
      });

      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : "LaTeX generation failed" });
    }
  });

  app.post("/api/session/:sessionId/linkedin/connect", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.setLinkedInConnected(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: "LinkedIn marked as connected in this browser session",
      at: Date.now(),
    });

    return reply.send({ ok: true, linkedinConnected: true });
  });

  app.post("/api/session/:sessionId/run/scan", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    const parse = runScanSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const { verify, company } = parse.data;
    emitPhase(sessionId, "scan", "Scanning job sources");

    // Grab latest session state for context (preferredRoles etc.)
    const scanSession = await app.sessionStore.get(sessionId);
    app.scanRunner
      .runScan({
        verify,
        company,
        roles: scanSession?.context?.preferredRoles ?? [],
        logger: app.log,
        onEvent: (event) => {
          void app.sessionStore.emit(sessionId, event);
        },
      })
      .then(async (jobs) => {
        await app.sessionStore.setJobs(sessionId, jobs);
        emitPhase(sessionId, "done", "Scan completed");
      })
      .catch((error) => {
        void app.sessionStore.emit(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown scan error",
          at: Date.now(),
        });
      });

    return reply.code(202).send({ ok: true, message: "Scan started" });
  });

  app.post("/api/session/:sessionId/run/autopilot", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }
    if (!session.context) {
      return reply.code(400).send({ message: "Session context is required before running autopilot" });
    }

    const parse = runScanSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const { verify, company } = parse.data;

    runAutopilotCycle(sessionId, verify, company)
      .catch((error) => {
        void app.sessionStore.emit(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : "Autopilot failed",
          at: Date.now(),
        });
      });

    app.automationScheduler.start({
      sessionId,
      intervalMinutes: session.automation.intervalMinutes,
      logger: app.log,
      runOnce: async () => runAutopilotCycle(sessionId, verify, company),
    });

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: `Autopilot scheduler active every ${session.automation.intervalMinutes} minutes`,
      at: Date.now(),
    });

    return reply.code(202).send({ ok: true, message: "Autopilot started" });
  });

  app.get("/api/session/:sessionId/jobs", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }
    return reply.send({ jobs: session.jobs });
  });

  app.get("/api/session/:sessionId/drafts", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }
    return reply.send({ rankedJobs: session.rankedJobs, drafts: session.drafts });
  });

  app.delete("/api/session/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    app.automationScheduler.stop(sessionId);
    await app.sessionStore.destroy(sessionId);
    return reply.send({ ok: true });
  });
}
