import type { FastifyInstance } from "fastify";

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/session/:sessionId/events", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await app.sessionStore.get(sessionId);
    if (!session) {
      return reply.notFound("Session not found or expired");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.raw.flushHeaders?.();

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: ping\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, 15_000);

    const unsubscribe = app.sessionStore.subscribe(sessionId, (event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    void app.sessionStore.emit(sessionId, {
      type: "status",
      message: "Live stream connected",
      at: Date.now(),
    });

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });
}
