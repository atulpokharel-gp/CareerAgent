import type { FastifyBaseLogger } from "fastify";

export class AutomationScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  start(params: {
    sessionId: string;
    intervalMinutes: number;
    logger: FastifyBaseLogger;
    runOnce: () => Promise<void>;
  }): void {
    this.stop(params.sessionId);

    const runSafely = async () => {
      try {
        await params.runOnce();
      } catch (error) {
        params.logger.error({ sessionId: params.sessionId, err: error }, "scheduled autopilot cycle failed");
      }
    };

    void runSafely();
    const timer = setInterval(() => {
      void runSafely();
    }, Math.max(2, params.intervalMinutes) * 60_000);

    timer.unref();
    this.timers.set(params.sessionId, timer);
  }

  stop(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(sessionId);
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
