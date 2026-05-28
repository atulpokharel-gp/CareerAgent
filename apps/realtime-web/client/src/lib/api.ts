export interface SessionCreated {
  sessionId: string;
  expiresAt: number;
  supportedProviders: string[];
}

export interface JobItem {
  company: string;
  title: string;
  location: string;
  url: string;
}

export interface RankedJob extends JobItem {
  score: number;
  reasons: string[];
}

export interface DraftApplication {
  jobUrl: string;
  company: string;
  title: string;
  coverLetter: string;
  shortPitch: string;
  status: "prepared" | "skipped";
  note: string;
}

export interface ParsedCvProfile {
  cleanedCv: string;
  skills: string[];
  preferredRoles: string[];
  locations: string[];
  goals: string;
  summary: string;
}

// On Vercel, VITE_API_BASE should be set to "" (empty string) — all /api/* requests are
// handled by the same-origin serverless function.  Locally, the dev proxy forwards /api/*
// to the Fastify server, so we can also leave VITE_API_BASE="" in .env.local.
// The fallback "http://localhost:8787" is kept for backwards-compatibility when no .env is set.
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

export async function createSession(): Promise<SessionCreated> {
  const response = await fetch(`${API_BASE}/api/session`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Failed to create session");
  }

  return response.json() as Promise<SessionCreated>;
}

export async function updateContext(sessionId: string, payload: {
  cv: string;
  skills: string;
  goals: string;
  preferredRoles: string[];
  locations: string[];
  providers: Array<{ provider: "openai" | "anthropic" | "gemini" | "openrouter"; apiKey: string }>;
}): Promise<void> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update context: ${body}`);
  }
}

export async function parseCvWithLlm(sessionId: string, payload: {
  provider: "openai" | "anthropic" | "gemini" | "openrouter";
  apiKey: string;
  cvText: string;
}): Promise<ParsedCvProfile> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/parse-cv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to parse CV: ${body}`);
  }

  return response.json() as Promise<ParsedCvProfile>;
}

export async function startScan(sessionId: string, verify: boolean): Promise<void> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/run/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ verify }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to start scan: ${body}`);
  }
}

export async function configureAutomation(sessionId: string, payload: {
  enabled: boolean;
  intervalMinutes: number;
  maxJobsPerRun: number;
  autoApplyRequested: boolean;
}): Promise<void> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/automation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to configure automation: ${body}`);
  }
}

export async function startAutopilot(sessionId: string, verify: boolean): Promise<void> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/run/autopilot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ verify }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to start autopilot: ${body}`);
  }
}

export async function getJobs(sessionId: string): Promise<JobItem[]> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/jobs`);
  if (!response.ok) {
    throw new Error("Failed to load jobs");
  }
  const body = await response.json() as { jobs: JobItem[] };
  return body.jobs;
}

export async function getDrafts(sessionId: string): Promise<{ rankedJobs: RankedJob[]; drafts: DraftApplication[] }> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/drafts`);
  if (!response.ok) {
    throw new Error("Failed to load drafts");
  }
  return response.json() as Promise<{ rankedJobs: RankedJob[]; drafts: DraftApplication[] }>;
}

export function createEventsSource(sessionId: string): EventSource {
  return new EventSource(`${API_BASE}/api/session/${sessionId}/events`);
}

// ── Local dev helpers ──────────────────────────────────────────────────────────

export interface LocalInitResult {
  apiKey: string;
  provider: "openai" | "anthropic" | "gemini" | "openrouter";
  hasCv: boolean;
}

export async function fetchLocalInit(): Promise<LocalInitResult | null> {
  try {
    const response = await fetch(`${API_BASE}/api/local/init`);
    if (!response.ok) return null;
    return response.json() as Promise<LocalInitResult>;
  } catch {
    return null;
  }
}

export async function fetchLocalCvBlob(): Promise<Blob | null> {
  try {
    const response = await fetch(`${API_BASE}/api/local/cv`);
    if (!response.ok) return null;
    return response.blob();
  } catch {
    return null;
  }
}

// ── Auto-apply ─────────────────────────────────────────────────────────────────

export type AtsType = "greenhouse" | "lever" | "ashby" | "unknown";

export interface ApplyRecord {
  jobUrl: string;
  company: string;
  title: string;
  ats: AtsType;
  status: "submitted" | "failed" | "unsupported";
  message: string;
  submittedAt: number;
}

export async function submitApplication(sessionId: string, jobUrl: string): Promise<ApplyRecord> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobUrl }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Auto-apply failed: ${body}`);
  }
  const body = await response.json() as { record: ApplyRecord };
  return body.record;
}

export async function bulkSubmitApplications(sessionId: string, jobUrls: string[]): Promise<ApplyRecord[]> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/apply/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobUrls }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bulk auto-apply failed: ${body}`);
  }
  const body = await response.json() as { records: ApplyRecord[] };
  return body.records;
}

export async function getApplyRecords(sessionId: string): Promise<ApplyRecord[]> {
  const response = await fetch(`${API_BASE}/api/session/${sessionId}/apply`);
  if (!response.ok) throw new Error("Failed to load apply records");
  const body = await response.json() as { records: ApplyRecord[] };
  return body.records;
}

// ── Apply memory / knowledge graph ────────────────────────────────────────────

export interface AtsKnowledge {
  attempts: number;
  successes: number;
  lastAttempt?: number;
  lastError?: string;
  strategy: string;
  learnedLessons: string[];
  requiredExtraFields: Record<string, unknown>;
}

export interface ApplyMemory {
  schemaVersion: number;
  updatedAt: number;
  ats: Record<string, AtsKnowledge>;
  jobs: Record<string, { ats: string; status: string; at: number; note?: string }>;
}

export async function getApplyMemory(): Promise<ApplyMemory | null> {
  try {
    const r = await fetch(`${API_BASE}/api/apply-memory`);
    if (!r.ok) return null;
    return r.json() as Promise<ApplyMemory>;
  } catch {
    return null;
  }
}

// ── ATS CV Optimization ───────────────────────────────────────────────────────

export interface AtsOptimizeResult {
  originalScore: number;
  optimizedScore: number;
  optimizedCv: string;
  issues: string[];
  keywordsAdded: string[];
  wasOptimized: boolean;
}

export interface AtsScoreResult {
  score: number;
  issues: string[];
}

export async function optimizeCvForAts(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
  targetRoles: string[],
  jobDescription?: string,
): Promise<AtsOptimizeResult> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/optimize-cv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cvText, targetRoles, jobDescription }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ message: "ATS optimization failed" }))) as { message?: string };
    throw new Error(err.message ?? "ATS optimization failed");
  }
  return r.json() as Promise<AtsOptimizeResult>;
}

export async function scoreCvAts(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
  targetRoles: string[],
): Promise<AtsScoreResult> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/score-cv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cvText, targetRoles }),
  });
  if (!r.ok) return { score: 0, issues: [] };
  return r.json() as Promise<AtsScoreResult>;
}

// ── Timeline & Goals ──────────────────────────────────────────────────────────

export interface ExperienceEntry {
  company: string;
  role: string;
  startYear: number;
  endYear: number | null;
  durationYears: number;
  description: string;
}

export interface EducationEntry {
  institution: string;
  degree: string;
  field: string;
  year: number;
}

export interface CvTimeline {
  experience: ExperienceEntry[];
  education: EducationEntry[];
  totalYearsExperience: number;
  careerGoals: string;
}

export async function parseCvTimeline(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
): Promise<CvTimeline | null> {
  try {
    const r = await fetch(`${API_BASE}/api/session/${sessionId}/parse-timeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey, cvText }),
    });
    if (!r.ok) return null;
    return r.json() as Promise<CvTimeline>;
  } catch {
    return null;
  }
}

export async function generateCareerGoals(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
): Promise<string> {
  try {
    const r = await fetch(`${API_BASE}/api/session/${sessionId}/generate-goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, apiKey, cvText }),
    });
    if (!r.ok) return "";
    const data = (await r.json()) as { goals?: string };
    return data.goals ?? "";
  } catch {
    return "";
  }
}

// ── Per-job ATS ───────────────────────────────────────────────────────────────

export async function optimizeCvForJob(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
  jobTitle: string,
  jobDescription: string,
): Promise<AtsOptimizeResult> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/job-ats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cvText, jobTitle, jobDescription }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ message: "Job ATS optimization failed" }))) as { message?: string };
    throw new Error(err.message ?? "Job ATS optimization failed");
  }
  return r.json() as Promise<AtsOptimizeResult>;
}

// ── LaTeX / HTML CV generator ─────────────────────────────────────────────────

export interface LatexCvResult {
  texFileName: string;
  htmlFileName: string;
  texDownloadUrl: string;
  htmlDownloadUrl: string;
  latexContent: string;
}

export async function generateLatexCv(
  sessionId: string,
  cvText: string,
  provider: string,
  apiKey: string,
  targetRole: string,
  slug?: string,
): Promise<LatexCvResult> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/generate-latex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cvText, targetRole, slug }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ message: "LaTeX generation failed" }))) as { message?: string };
    throw new Error(err.message ?? "LaTeX generation failed");
  }
  return r.json() as Promise<LatexCvResult>;
}

// ── Full workflow ─────────────────────────────────────────────────────────────

export async function startWorkflow(
  sessionId: string,
  cv: string,
  provider: string,
  apiKey: string,
  options: {
    autoApply?: boolean;
    maxJobs?: number;
    verify?: boolean;
    company?: string;
  } = {},
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/run-workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cv, ...options }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ message: "Workflow failed to start" }))) as { message?: string };
    throw new Error(err.message ?? "Workflow failed to start");
  }
}

// ── CV Chatbot ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface ChatResponse {
  reply: string;
  updatedCv: string | null;
}

export async function sendCvChatMessage(
  sessionId: string,
  cv: string,
  provider: string,
  apiKey: string,
  message: string,
  history: ChatMessage[],
): Promise<ChatResponse> {
  const r = await fetch(`${API_BASE}/api/session/${sessionId}/cv-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey, cv, message, history }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ message: "Chat failed" }))) as { message?: string };
    throw new Error(err.message ?? "Chat failed");
  }
  return r.json() as Promise<ChatResponse>;
}

// ── Persistent user data ──────────────────────────────────────────────────────

export interface CvVersion {
  id: string;
  createdAt: number;
  label: string;
  content: string;
  atsScore: number | null;
  targetRole: string | null;
  latexUrl: string | null;
  htmlUrl: string | null;
}

export interface ApplicationRecord {
  jobUrl: string;
  company: string;
  jobTitle: string;
  jobLocation: string;
  title: string;
  ats: AtsType;
  status: "submitted" | "failed" | "unsupported";
  message: string;
  submittedAt: number;
  atsScore: number | null;
  notes: string;
}

export interface UserData {
  lastUpdated: number;
  cvVersions: CvVersion[];
  applications: ApplicationRecord[];
  timeline: CvTimeline | null;
  chatHistory: ChatMessage[];
}

export async function fetchUserData(): Promise<UserData | null> {
  try {
    const r = await fetch(`${API_BASE}/api/user-data`);
    if (!r.ok) return null;
    return r.json() as Promise<UserData>;
  } catch {
    return null;
  }
}

// ── Persistent job DB (local scan history) ─────────────────────────────────────

export type TrackedJobStatus = "shortlisted" | "applied" | "rejected" | "skipped";

export interface TrackedJob {
  url: string;
  company: string;
  title: string;
  location: string;
  score: number;
  reasons: string[];
  status: TrackedJobStatus;
  scannedAt: number;
  appliedAt?: number;
}

export interface JobStats {
  total: number;
  shortlisted: number;
  applied: number;
  rejected: number;
  skipped: number;
}

export async function fetchJobStats(): Promise<JobStats> {
  try {
    const r = await fetch(`${API_BASE}/api/data/jobs/stats`);
    if (!r.ok) return { total: 0, shortlisted: 0, applied: 0, rejected: 0, skipped: 0 };
    return r.json() as Promise<JobStats>;
  } catch {
    return { total: 0, shortlisted: 0, applied: 0, rejected: 0, skipped: 0 };
  }
}

export async function fetchTrackedJobs(status?: TrackedJobStatus): Promise<TrackedJob[]> {
  try {
    const url = status
      ? `${API_BASE}/api/data/jobs?status=${status}`
      : `${API_BASE}/api/data/jobs`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const body = await r.json() as { jobs: TrackedJob[] };
    return body.jobs;
  } catch {
    return [];
  }
}

export async function updateJobStatus(jobUrl: string, status: TrackedJobStatus): Promise<void> {
  await fetch(`${API_BASE}/api/data/jobs/${encodeURIComponent(jobUrl)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}
