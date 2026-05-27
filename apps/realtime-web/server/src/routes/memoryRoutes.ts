import type { FastifyInstance } from "fastify";
import { applyMemory } from "../services/applyMemory.js";

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/apply-memory
   * Returns the entire apply knowledge graph.
   * This is public (session-independent) because the memory is global to the agent.
   */
  app.get("/api/apply-memory", async (_request, reply) => {
    const memory = await applyMemory.getAll();
    return reply.send(memory);
  });
}
