/**
 * PersistentStorage
 *
 * Saves all user data to a single JSON file on disk so the session survives
 * server restarts. Stored at  <repoRoot>/apps/realtime-web/data/user-data.json
 *
 * Schema: { cvVersions, applications, timeline, lastUpdated }
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { ApplyRecord } from "../types.js";
import type { CvTimeline } from "./cvTimelineParser.js";

export interface CvVersion {
  id: string;
  createdAt: number;
  label: string;         // "original" | "ats-optimized-for-{company}" | "chatbot-v{n}"
  content: string;
  atsScore: number | null;
  targetRole: string | null;
  latexUrl: string | null;
  htmlUrl: string | null;
}

export interface ApplicationRecord extends ApplyRecord {
  jobTitle: string;
  jobLocation: string;
  cvVersionId: string | null;
  atsScore: number | null;
  notes: string;
}

/**
 * Every job ever found by the scanner is stored here so:
 * 1. New scans only surface FRESH jobs (URLs not yet seen).
 * 2. The ranker can boost roles similar to ones the user has applied to.
 * 3. Applied / rejected / skipped history is preserved across server restarts.
 */
export interface TrackedJob {
  url: string;
  company: string;
  title: string;
  location: string;
  score: number;
  reasons: string[];
  /** Current lifecycle status for this job. */
  status: "shortlisted" | "applied" | "rejected" | "skipped";
  scannedAt: number;
  /** Set when status transitions to "applied". */
  appliedAt?: number;
}

export interface JobStats {
  total: number;
  shortlisted: number;
  applied: number;
  rejected: number;
  skipped: number;
}

export interface UserData {
  lastUpdated: number;
  cvVersions: CvVersion[];
  applications: ApplicationRecord[];
  timeline: CvTimeline | null;
  chatHistory: { role: "user" | "assistant"; content: string; at: number }[];
  /** Full job history — every URL ever seen. Used to deduplicate scans. */
  trackedJobs: TrackedJob[];
}

const EMPTY: UserData = {
  lastUpdated: 0,
  cvVersions: [],
  applications: [],
  timeline: null,
  chatHistory: [],
  trackedJobs: [],
};

const DATA_PATH = path.join(config.dataDir, "user-data.json");

async function ensure(): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
}

export async function loadUserData(): Promise<UserData> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw) as UserData;
    // Back-fill trackedJobs for data written before this field existed
    if (!parsed.trackedJobs) parsed.trackedJobs = [];
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

export async function saveUserData(data: UserData): Promise<void> {
  await ensure();
  data.lastUpdated = Date.now();
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

export async function addCvVersion(version: Omit<CvVersion, "id" | "createdAt">): Promise<CvVersion> {
  const data = await loadUserData();
  const entry: CvVersion = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...version,
  };
  // keep max 50 versions
  data.cvVersions = [entry, ...data.cvVersions].slice(0, 50);
  await saveUserData(data);
  return entry;
}

export async function upsertApplication(record: ApplicationRecord): Promise<void> {
  const data = await loadUserData();
  const idx = data.applications.findIndex((a) => a.jobUrl === record.jobUrl);
  if (idx >= 0) {
    data.applications[idx] = record;
  } else {
    data.applications.unshift(record);
  }
  await saveUserData(data);
}

export async function saveTimeline(timeline: CvTimeline): Promise<void> {
  const data = await loadUserData();
  data.timeline = timeline;
  await saveUserData(data);
}

export async function appendChatMessage(
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const data = await loadUserData();
  data.chatHistory = [{ role, content, at: Date.now() }, ...data.chatHistory].slice(0, 200);
  await saveUserData(data);
}

// ── Job tracking ────────────────────────────────────────────────────────────

/**
 * Persist a batch of new jobs to the DB. Existing URLs are only updated if
 * the incoming score is higher (we never downgrade a job's score in history).
 * Jobs whose status is already "applied" are never overwritten.
 */
export async function upsertTrackedJobs(jobs: TrackedJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const data = await loadUserData();
  const map = new Map(data.trackedJobs.map((j) => [j.url, j]));
  for (const job of jobs) {
    const existing = map.get(job.url);
    if (!existing) {
      map.set(job.url, job);
    } else if (existing.status !== "applied") {
      // Update score/reasons if we have a better reading, keep history status
      map.set(job.url, {
        ...existing,
        score: Math.max(existing.score, job.score),
        reasons: job.reasons.length > existing.reasons.length ? job.reasons : existing.reasons,
        // Refresh scannedAt only if this is truly newer
        scannedAt: Math.max(existing.scannedAt, job.scannedAt),
      });
    }
  }
  data.trackedJobs = [...map.values()];
  await saveUserData(data);
}

/**
 * Update the status of a single job (e.g. applied, rejected, skipped).
 */
export async function markJobStatus(
  url: string,
  status: TrackedJob["status"],
  at = Date.now(),
): Promise<void> {
  const data = await loadUserData();
  const idx = data.trackedJobs.findIndex((j) => j.url === url);
  if (idx >= 0) {
    data.trackedJobs[idx] = {
      ...data.trackedJobs[idx],
      status,
      ...(status === "applied" ? { appliedAt: at } : {}),
    };
  }
  await saveUserData(data);
}

/**
 * Filter an incoming list of jobs to only those whose URL has NEVER been seen
 * before. Already-applied jobs are always excluded.
 * Returns only the new / unseen subset.
 */
export async function filterToNewJobs<T extends { url: string }>(incoming: T[]): Promise<T[]> {
  const data = await loadUserData();
  const seenUrls = new Set(data.trackedJobs.map((j) => j.url));
  return incoming.filter((j) => !seenUrls.has(j.url));
}

/**
 * Extract title keywords from jobs the user has actually applied to.
 * Used by the ranker to boost similar roles in future scans.
 */
export async function getAppliedRoleKeywords(): Promise<string[]> {
  const data = await loadUserData();
  const applied = data.trackedJobs.filter((j) => j.status === "applied");
  const keywords = new Set<string>();
  for (const job of applied) {
    // Split job title into individual words; keep meaningful tokens (≥4 chars)
    job.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .forEach((w) => keywords.add(w));
  }
  return [...keywords];
}

/** Aggregate counts for the dashboard. */
export async function getJobStats(): Promise<JobStats> {
  const data = await loadUserData();
  const stats: JobStats = { total: 0, shortlisted: 0, applied: 0, rejected: 0, skipped: 0 };
  for (const j of data.trackedJobs) {
    stats.total++;
    stats[j.status]++;
  }
  return stats;
}

/** Return all tracked jobs, optionally filtered by status. */
export async function getTrackedJobs(status?: TrackedJob["status"]): Promise<TrackedJob[]> {
  const data = await loadUserData();
  return status ? data.trackedJobs.filter((j) => j.status === status) : data.trackedJobs;
}
