/**
 * ApplyMemory — persistent knowledge base for the self-improving apply agent.
 *
 * Each time an application is attempted the agent records:
 *   • Whether it succeeded or failed
 *   • What the API/form returned as an error
 *   • A lesson synthesised by the LLM from that error
 *   • Any extra request fields that fixed the problem
 *
 * Over time the "ats" map grows richer so subsequent submissions for the same
 * platform use the accumulated knowledge without re-querying the LLM.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AtsKnowledge {
  /** Number of application attempts ever made through this ATS. */
  attempts: number;
  /** How many of those succeeded (HTTP 2xx, no error in body). */
  successes: number;
  /** Unix ms of the most recent attempt. */
  lastAttempt?: number;
  /** Truncated error string from the most recent failure. */
  lastError?: string;
  /** Strategy the agent is currently using for this ATS. */
  strategy: "api-direct" | "enhanced-api" | "page-scrape" | "unsupported";
  /** Lessons the LLM has synthesised from past errors (newest last). */
  learnedLessons: string[];
  /** Extra request-body fields the agent learned are required for this ATS. */
  requiredExtraFields: Record<string, unknown>;
  /** Maps human-readable field labels → API field names (learned from errors). */
  fieldMappings: Record<string, string>;
}

export interface JobKnowledge {
  ats: string;
  status: "submitted" | "failed" | "unsupported";
  at: number;
  note?: string;
}

export interface ApplyMemory {
  schemaVersion: 1;
  updatedAt: number;
  /** Per-ATS accumulated knowledge. Keys: "greenhouse", "lever", "ashby", etc. */
  ats: Record<string, AtsKnowledge>;
  /** Per-URL job history. Keys: the full job URL. */
  jobs: Record<string, JobKnowledge>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MEMORY_PATH = path.join(
  config.repoRoot,
  "apps",
  "realtime-web",
  "data",
  "apply-memory.json",
);

function makeDefaultAtsEntry(): AtsKnowledge {
  return {
    attempts: 0,
    successes: 0,
    strategy: "api-direct",
    learnedLessons: [],
    requiredExtraFields: {},
    fieldMappings: {},
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ApplyMemoryService {
  private memory: ApplyMemory | null = null;

  // -- load / save -----------------------------------------------------------

  async load(): Promise<ApplyMemory> {
    if (this.memory) return this.memory;
    try {
      const raw = await fs.readFile(MEMORY_PATH, "utf8");
      this.memory = JSON.parse(raw) as ApplyMemory;
    } catch {
      this.memory = {
        schemaVersion: 1,
        updatedAt: Date.now(),
        ats: {},
        jobs: {},
      };
    }
    return this.memory;
  }

  private async save(): Promise<void> {
    if (!this.memory) return;
    this.memory.updatedAt = Date.now();
    try {
      await fs.mkdir(path.dirname(MEMORY_PATH), { recursive: true });
      await fs.writeFile(MEMORY_PATH, JSON.stringify(this.memory, null, 2), "utf8");
    } catch (err) {
      console.error("[applyMemory] save failed:", err);
    }
  }

  // -- read ------------------------------------------------------------------

  async getAtsKnowledge(ats: string): Promise<AtsKnowledge> {
    const mem = await this.load();
    return { ...makeDefaultAtsEntry(), ...(mem.ats[ats] ?? {}) };
  }

  async getAll(): Promise<ApplyMemory> {
    return this.load();
  }

  /** Return true if we already successfully submitted to this URL. */
  async alreadySubmitted(jobUrl: string): Promise<boolean> {
    const mem = await this.load();
    return mem.jobs[jobUrl]?.status === "submitted";
  }

  // -- write -----------------------------------------------------------------

  /**
   * Record the outcome of a single application attempt.
   * @param jobUrl     The canonical URL of the job posting.
   * @param ats        ATS type string ("greenhouse", "lever", "ashby", etc.)
   * @param success    Whether the submission was accepted.
   * @param error      Raw error message / body (truncated internally).
   * @param lesson     Human-readable lesson synthesised by LLM (optional).
   * @param extraFields Extra fields that were required (optional, merged in).
   * @param strategy   Strategy that was used for this attempt (optional).
   */
  async recordAttempt(
    jobUrl: string,
    ats: string,
    success: boolean,
    {
      error,
      lesson,
      extraFields,
      strategy,
    }: {
      error?: string;
      lesson?: string;
      extraFields?: Record<string, unknown>;
      strategy?: AtsKnowledge["strategy"];
    } = {},
  ): Promise<void> {
    const mem = await this.load();

    if (!mem.ats[ats]) mem.ats[ats] = makeDefaultAtsEntry();
    const entry = mem.ats[ats];

    entry.attempts++;
    entry.lastAttempt = Date.now();

    if (success) {
      entry.successes++;
    } else if (error) {
      entry.lastError = error.slice(0, 500);
    }

    if (lesson) {
      if (!entry.learnedLessons.includes(lesson)) {
        entry.learnedLessons.push(lesson);
        if (entry.learnedLessons.length > 25) entry.learnedLessons.shift();
      }
    }

    if (extraFields && Object.keys(extraFields).length > 0) {
      Object.assign(entry.requiredExtraFields, extraFields);
    }

    if (strategy) entry.strategy = strategy;

    mem.jobs[jobUrl] = {
      ats,
      status: success ? "submitted" : "failed",
      at: Date.now(),
      note: lesson,
    };

    await this.save();
  }

  /** Mark an unsupported job (no API available for this ATS). */
  async recordUnsupported(jobUrl: string, ats: string): Promise<void> {
    const mem = await this.load();
    if (!mem.ats[ats]) {
      mem.ats[ats] = { ...makeDefaultAtsEntry(), strategy: "unsupported" };
    }
    mem.ats[ats].attempts++;
    mem.ats[ats].lastAttempt = Date.now();
    mem.jobs[jobUrl] = { ats, status: "unsupported", at: Date.now() };
    await this.save();
  }
}

export const applyMemory = new ApplyMemoryService();
