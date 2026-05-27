import { nanoid } from "nanoid";
import { createClient, type RedisClientType } from "redis";
import type { ApplyRecord, ProviderKey, SessionEvent, SessionState, UserContext } from "../types.js";

export class SessionStore {
  private readonly listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  private readonly redis?: RedisClientType;
  private readonly subscriber?: RedisClientType;
  private readonly memorySessions = new Map<string, SessionState>();
  private readonly useRedis: boolean;
  private initialized = false;

  constructor(
    private readonly ttlMs: number,
    private readonly _maxSessions: number,
    private readonly redisUrl: string,
    private readonly keyPrefix: string,
  ) {
    this.useRedis = this.redisUrl !== "memory";
    if (this.useRedis) {
      this.redis = createClient({ url: this.redisUrl });
      this.subscriber = this.redis.duplicate();
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.useRedis || !this.redis || !this.subscriber) {
      this.initialized = true;
      return;
    }
    await this.redis.connect();
    await this.subscriber.connect();
    await this.subscriber.pSubscribe(`${this.keyPrefix}:events:*`, (message, channel) => {
      const sessionId = channel.split(":").at(-1);
      if (!sessionId) return;
      try {
        const event = JSON.parse(message) as SessionEvent;
        this.dispatchLocal(sessionId, event);
      } catch {
        // Ignore malformed fanout messages.
      }
    });
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.useRedis || !this.redis || !this.subscriber) {
      return;
    }
    await this.subscriber.pUnsubscribe(`${this.keyPrefix}:events:*`);
    await this.subscriber.quit();
    await this.redis.quit();
  }

  async create(): Promise<SessionState> {
    const now = Date.now();
    const session: SessionState = {
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      providerKeys: [],
      jobs: [],
      rankedJobs: [],
      drafts: [],
      applyRecords: [],
      linkedinConnected: false,
      automation: {
        enabled: false,
        intervalMinutes: 15,
        maxJobsPerRun: 15,
        autoApplyRequested: false,
      },
    };

    await this.writeSession(session);
    return session;
  }

  async get(sessionId: string): Promise<SessionState | undefined> {
    const session = await this.readSession(sessionId);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt < Date.now()) {
      await this.destroy(sessionId);
      return undefined;
    }
    return session;
  }

  async touch(session: SessionState): Promise<void> {
    const now = Date.now();
    session.updatedAt = now;
    session.expiresAt = now + this.ttlMs;
    await this.writeSession(session);
  }

  async setContext(sessionId: string, context: UserContext, providerKeys: ProviderKey[]): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.context = context;
    session.providerKeys = providerKeys;
    await this.touch(session);
    return session;
  }

  async setJobs(sessionId: string, jobs: SessionState["jobs"]): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.jobs = jobs;
    await this.touch(session);
    return session;
  }

  async setRankedJobs(sessionId: string, jobs: SessionState["rankedJobs"]): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.rankedJobs = jobs;
    await this.touch(session);
    return session;
  }

  async setDrafts(sessionId: string, drafts: SessionState["drafts"]): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.drafts = drafts;
    await this.touch(session);
    return session;
  }

  async setAutomation(sessionId: string, automation: SessionState["automation"]): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.automation = automation;
    await this.touch(session);
    return session;
  }

  async setLinkedInConnected(sessionId: string): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.linkedinConnected = true;
    await this.touch(session);
    return session;
  }

  async addApplyRecord(sessionId: string, record: ApplyRecord): Promise<SessionState | undefined> {
    const session = await this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.applyRecords = [...(session.applyRecords ?? []), record];
    await this.touch(session);
    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    if (this.useRedis && this.redis) {
      await this.redis.del(this.sessionKey(sessionId));
    } else {
      this.memorySessions.delete(sessionId);
    }
    this.listeners.delete(sessionId);
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) || new Set<(event: SessionEvent) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);

    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  async emit(sessionId: string, event: SessionEvent): Promise<void> {
    this.dispatchLocal(sessionId, event);
    if (this.useRedis && this.redis) {
      await this.redis.publish(this.eventChannel(sessionId), JSON.stringify(event));
    }
  }

  async tryAcquireAutopilotLease(sessionId: string, leaseMs: number): Promise<boolean> {
    if (!this.useRedis || !this.redis) {
      return true;
    }
    const key = `${this.keyPrefix}:lease:${sessionId}`;
    const result = await this.redis.set(key, nanoid(), {
      NX: true,
      PX: Math.max(5_000, leaseMs),
    });
    return result === "OK";
  }

  private dispatchLocal(sessionId: string, event: SessionEvent): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }

  private async readSession(sessionId: string): Promise<SessionState | undefined> {
    if (this.useRedis && this.redis) {
      const raw = await this.redis.get(this.sessionKey(sessionId));
      if (!raw) return undefined;
      return JSON.parse(raw) as SessionState;
    }

    const session = this.memorySessions.get(sessionId);
    return session ? { ...session } : undefined;
  }

  private async writeSession(session: SessionState): Promise<void> {
    if (this.useRedis && this.redis) {
      await this.redis.set(this.sessionKey(session.id), JSON.stringify(session), {
        PX: Math.max(60_000, this.ttlMs),
      });
      return;
    }

    this.memorySessions.set(session.id, { ...session });
  }

  private sessionKey(sessionId: string): string {
    return `${this.keyPrefix}:session:${sessionId}`;
  }

  private eventChannel(sessionId: string): string {
    return `${this.keyPrefix}:events:${sessionId}`;
  }
}
