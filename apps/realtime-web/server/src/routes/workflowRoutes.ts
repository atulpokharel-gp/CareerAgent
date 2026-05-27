/**
 * Workflow Routes
 *
 * POST /api/session/:id/run-workflow   — kick off the full pipeline (streamed via SSE)
 * POST /api/session/:id/cv-chat        — chatbot for CV editing
 * GET  /api/user-data                  — fetch all persisted user data
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { runWorkflow } from "../services/workflowService.js";
import { chatWithCv } from "../services/cvChatService.js";
import { loadUserData } from "../services/persistentStorage.js";
import type { ProviderKey } from "../types.js";

const workflowSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
  apiKey: z.string().min(12).max(300),
  cv: z.string().min(20).max(140_000),
  autoApply: z.boolean().default(false),
  maxJobs: z.number().int().min(1).max(50).default(10),
  verify: z.boolean().default(false),
  company: z.string().max(160).optional(),
});

const chatSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
  apiKey: z.string().min(12).max(300),
  cv: z.string().min(10).max(140_000),
  message: z.string().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(6000),
    at: z.number(),
  })).max(20).default([]),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {

  /** GET /api/user-data — fetch all saved applications, CV versions, timeline */
  app.get("/api/user-data", async (_request, reply) => {
    const data = await loadUserData();
    return reply.send(data);
  });

  /** POST /api/session/:id/run-workflow — full pipeline, events streamed via SSE */
  app.post("/api/session/:id/run-workflow", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await app.sessionStore.get(id);
    if (!session) return reply.notFound("Session not found");

    const body = workflowSchema.safeParse(request.body);
    if (!body.success) return reply.badRequest(body.error.message);

    const { provider, apiKey, cv, autoApply, maxJobs, verify, company } = body.data;
    const providerKey: ProviderKey = { provider, apiKey };

    // Kick off async — events land in SSE channel
    void runWorkflow({
      session,
      cv,
      providerKey,
      autoApply,
      maxJobs,
      logger: app.log,
      onEvent: (event) => {
        void app.sessionStore.emit(id, event as Parameters<typeof app.sessionStore.emit>[1]);
      },
      scan: async () => app.scanRunner.runScan({
        verify,
        company,
        logger: app.log,
        onEvent: (event) => {
          void app.sessionStore.emit(id, event);
        },
      }),
    });

    return reply.send({ ok: true, message: "Workflow started — follow SSE stream for progress" });
  });

  /** POST /api/session/:id/cv-chat — chatbot for CV editing */
  app.post("/api/session/:id/cv-chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await app.sessionStore.get(id);
    if (!session) return reply.notFound("Session not found");

    const body = chatSchema.safeParse(request.body);
    if (!body.success) return reply.badRequest(body.error.message);

    const { provider, apiKey, cv, message, history } = body.data;
    const providerKey: ProviderKey = { provider, apiKey };

    const result = await chatWithCv(cv, history, message, providerKey);
    return reply.send(result);
  });
}
