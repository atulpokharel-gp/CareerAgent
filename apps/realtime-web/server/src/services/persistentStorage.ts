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

export interface UserData {
  lastUpdated: number;
  cvVersions: CvVersion[];
  applications: ApplicationRecord[];
  timeline: CvTimeline | null;
  chatHistory: { role: "user" | "assistant"; content: string; at: number }[];
}

const EMPTY: UserData = {
  lastUpdated: 0,
  cvVersions: [],
  applications: [],
  timeline: null,
  chatHistory: [],
};

const DATA_PATH = path.join(config.dataDir, "user-data.json");

async function ensure(): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
}

export async function loadUserData(): Promise<UserData> {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw) as UserData;
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
