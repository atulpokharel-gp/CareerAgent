import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AutoApplyService } from "../services/autoApplyService.js";
import { browserApplyService } from "../services/browserApplyService.js";
import { IS_VERCEL, config } from "../config.js";
import type { ApplyPolicy, ApplyRecord, DraftApplication, RankedJob, SessionState } from "../types.js";

const autoApplyService = new AutoApplyService();

/**
 * Resolve effective apply policy by merging session override on top of
 * the global config defaults. Session settings always win when set.
 */
function resolvePolicy(session: SessionState): Required<ApplyPolicy> {
  const sessionPolicy = session.automation?.policy ?? {};
  return {
    minApplyScore: sessionPolicy.minApplyScore ?? config.applyPolicy.minApplyScore,
    allowAutoSubmit: sessionPolicy.allowAutoSubmit ?? config.applyPolicy.allowAutoSubmit,
    dryRun: sessionPolicy.dryRun ?? config.applyPolicy.dryRun,
    safeMode: sessionPolicy.safeMode ?? config.applyPolicy.safeMode,
    maxApplicationsPerDay:
      sessionPolicy.maxApplicationsPerDay ?? config.applyPolicy.maxApplicationsPerDay,
  };
}

/**
 * Check guardrails before submitting an application. Returns a synthetic
 * ApplyRecord describing the block reason, or null if it's safe to proceed.
 */
function checkPolicy(
  draft: DraftApplication,
  ranked: RankedJob | undefined,
  policy: Required<ApplyPolicy>,
  submittedToday: number,
): ApplyRecord | null {
  const now = Date.now();
  const base = {
    jobUrl: draft.jobUrl,
    company: draft.company,
    title: draft.title,
    ats: "unknown" as const,
    submittedAt: now,
  };

  if (policy.safeMode) {
    return {
      ...base,
      status: "blocked_safe_mode",
      message: "Safe mode is on. The packet was prepared but never submitted.",
    };
  }
  if (!policy.allowAutoSubmit) {
    return {
      ...base,
      status: "blocked_safe_mode",
      message: "Auto-submit is disabled in the apply policy.",
    };
  }
  if (submittedToday >= policy.maxApplicationsPerDay) {
    return {
      ...base,
      status: "blocked_safe_mode",
      message: `Daily cap of ${policy.maxApplicationsPerDay} applications reached.`,
    };
  }
  if (draft.status === "needs_user_input") {
    return {
      ...base,
      status: "blocked_needs_user_input",
      message: `Missing required fields: ${(draft.missingFields ?? []).join(", ") || "unknown"}`,
      needsUserInput: draft.missingFields,
    };
  }
  // Threshold check — only blocks when a score is known. Manual single-job
  // applies (no ranking yet) are allowed through with a warning at the caller.
  if (ranked && typeof ranked.score === "number" && ranked.score < policy.minApplyScore) {
    return {
      ...base,
      status: "blocked_below_threshold",
      message: `Score ${ranked.score} is below the ${policy.minApplyScore} threshold.`,
      score: ranked.score,
    };
  }
  if (policy.dryRun) {
    return {
      ...base,
      status: "blocked_dry_run",
      message: "Dry run: form would be filled but not submitted.",
      score: ranked?.score,
    };
  }
  return null;
}

/**
 * Apply strategy: try browser automation first (works universally), fall back
 * to direct ATS API only if browser fails or is unavailable (Vercel).
 */
async function applyWithBestStrategy(
  draft: Parameters<AutoApplyService["submitApplication"]>[0],
  cvText: string,
  providerKey: Parameters<AutoApplyService["submitApplication"]>[2],
  emitStatus: (msg: string) => void,
): Promise<ReturnType<AutoApplyService["submitApplication"]>> {
  // Browser automation — works for ANY ATS portal
  if (!IS_VERCEL) {
    const result = await browserApplyService.applyWithBrowser(draft, cvText, providerKey, emitStatus);
    // If browser succeeded or gave a meaningful failure, return it
    if (result.status === "submitted") return result;
    // If the failure is not a "browser unavailable" issue, still return it
    if (!result.message.includes("not available in the hosted environment")) return result;
  }
  // Fallback: direct ATS API (Greenhouse / Lever / Ashby)
  return autoApplyService.submitApplication(draft, cvText, providerKey);
}

const submitSchema = z.object({
  jobUrl: z.string().url().max(2048),
  /** Caller may force a one-shot policy override (e.g. user clicks "Force apply"). */
  override: z.object({
    minApplyScore: z.number().min(0).max(100).optional(),
    allowAutoSubmit: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    safeMode: z.boolean().optional(),
  }).optional(),
});

const bulkSubmitSchema = z.object({
  jobUrls: z.array(z.string().url().max(2048)).min(1).max(50),
  override: z.object({
    minApplyScore: z.number().min(0).max(100).optional(),
    allowAutoSubmit: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    safeMode: z.boolean().optional(),
  }).optional(),
});

export async function registerApplyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/session/:sessionId/apply
   * Submit a single application.  The user must have confirmed before calling this.
   */
  app.post("/api/session/:sessionId/apply", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const parse = submitSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    // Find the draft for this job URL
    const draft = session.drafts.find((d) => d.jobUrl === parse.data.jobUrl);
    if (!draft) {
      return reply.code(404).send({ error: "No draft found for this job URL. Run the autopilot first." });
    }

    if (!session.context?.cv) {
      return reply.code(400).send({ error: "Session has no CV. Set context first." });
    }

    // Prevent duplicate submissions
    const alreadySubmitted = (session.applyRecords ?? []).some(
      (r) => r.jobUrl === parse.data.jobUrl && r.status === "submitted",
    );
    if (alreadySubmitted) {
      return reply.send({ alreadySubmitted: true, message: "Application already submitted for this job." });
    }

    // ── Apply-policy guardrails ────────────────────────────────────────────
    const policy = { ...resolvePolicy(session), ...(parse.data.override ?? {}) };
    const ranked = (session.rankedJobs ?? []).find((r) => r.url === parse.data.jobUrl);
    const dayMs = 24 * 60 * 60 * 1000;
    const submittedToday = (session.applyRecords ?? []).filter(
      (r) => r.status === "submitted" && Date.now() - r.submittedAt < dayMs,
    ).length;
    const blocked = checkPolicy(draft, ranked, policy, submittedToday);
    if (blocked) {
      await app.sessionStore.addApplyRecord(sessionId, blocked);
      void app.sessionStore.emit(sessionId, {
        type: "apply_blocked",
        jobUrl: blocked.jobUrl,
        reason: blocked.message,
        score: blocked.score,
        at: Date.now(),
      });
      if (blocked.status === "blocked_needs_user_input") {
        void app.sessionStore.emit(sessionId, {
          type: "needs_user_input",
          jobUrl: blocked.jobUrl,
          fields: blocked.needsUserInput ?? [],
          at: Date.now(),
        });
      }
      return reply.send({ record: blocked, blocked: true });
    }

    const providerKey = session.context?.providers?.[0];
    const record = await applyWithBestStrategy(
      draft,
      session.context.cv,
      providerKey,
      (msg) => void app.sessionStore.emit(sessionId, { type: "status", message: msg, at: Date.now() }),
    );

    await app.sessionStore.addApplyRecord(sessionId, record);

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: record.status === "submitted"
        ? `Applied to ${record.company} – ${record.title} ✓`
        : `Auto-apply to ${record.company} – ${record.title}: ${record.message}`,
      at: Date.now(),
    });

    return reply.send({ record });
  });

  /**
   * POST /api/session/:sessionId/apply/bulk
   * Submit multiple applications in sequence.
   */
  app.post("/api/session/:sessionId/apply/bulk", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const parse = bulkSubmitSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: parse.error.flatten() });
    }

    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }
    if (!session.context?.cv) {
      return reply.code(400).send({ error: "Session has no CV. Set context first." });
    }

    const records = [];
    const policy = { ...resolvePolicy(session), ...(parse.data.override ?? {}) };
    const dayMs = 24 * 60 * 60 * 1000;
    let submittedToday = (session.applyRecords ?? []).filter(
      (r) => r.status === "submitted" && Date.now() - r.submittedAt < dayMs,
    ).length;

    for (const jobUrl of parse.data.jobUrls) {
      const draft = session.drafts.find((d) => d.jobUrl === jobUrl);
      if (!draft) continue;

      const alreadyDone = (session.applyRecords ?? []).some(
        (r) => r.jobUrl === jobUrl && r.status === "submitted",
      );
      if (alreadyDone) continue;

      // Enforce guardrails per-job before any browser/API call
      const ranked = (session.rankedJobs ?? []).find((r) => r.url === jobUrl);
      const blocked = checkPolicy(draft, ranked, policy, submittedToday);
      if (blocked) {
        await app.sessionStore.addApplyRecord(sessionId, blocked);
        records.push(blocked);
        void app.sessionStore.emit(sessionId, {
          type: "apply_blocked",
          jobUrl: blocked.jobUrl,
          reason: blocked.message,
          score: blocked.score,
          at: Date.now(),
        });
        continue;
      }

      const bulkProviderKey = session.context?.providers?.[0];
      const record = await applyWithBestStrategy(
        draft,
        session.context.cv,
        bulkProviderKey,
        (msg) => void app.sessionStore.emit(sessionId, { type: "status", message: msg, at: Date.now() }),
      );
      await app.sessionStore.addApplyRecord(sessionId, record);
      records.push(record);
      if (record.status === "submitted") submittedToday++;

      void app.sessionStore.emit(sessionId, {
        type: "status",
        message: record.status === "submitted"
          ? `Applied to ${record.company} – ${record.title} ✓`
          : `Auto-apply to ${record.company}: ${record.message}`,
        at: Date.now(),
      });
    }

    return reply.send({ records });
  });

  /**
   * GET /api/session/:sessionId/apply
   * Get all apply records for this session.
   */
  app.get("/api/session/:sessionId/apply", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }
    return reply.send({ records: session.applyRecords ?? [] });
  });
}
