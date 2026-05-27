import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AutoApplyService } from "../services/autoApplyService.js";

const autoApplyService = new AutoApplyService();

const submitSchema = z.object({
  jobUrl: z.string().url().max(2048),
});

const bulkSubmitSchema = z.object({
  jobUrls: z.array(z.string().url().max(2048)).min(1).max(50),
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

    const providerKey = session.context?.providers?.[0];
    const record = await autoApplyService.submitApplication(draft, session.context.cv, providerKey);

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
    for (const jobUrl of parse.data.jobUrls) {
      const draft = session.drafts.find((d) => d.jobUrl === jobUrl);
      if (!draft) continue;

      const alreadyDone = (session.applyRecords ?? []).some(
        (r) => r.jobUrl === jobUrl && r.status === "submitted",
      );
      if (alreadyDone) continue;

      const bulkProviderKey = session.context?.providers?.[0];
      const record = await autoApplyService.submitApplication(draft, session.context.cv, bulkProviderKey);
      await app.sessionStore.addApplyRecord(sessionId, record);
      records.push(record);

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
