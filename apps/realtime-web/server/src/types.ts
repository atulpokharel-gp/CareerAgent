export type SupportedProvider = "openai" | "anthropic" | "gemini" | "openrouter";

export interface ProviderKey {
  provider: SupportedProvider;
  apiKey: string;
}

export interface UserContext {
  cv: string;
  skills: string;
  goals: string;
  preferredRoles: string[];
  locations: string[];
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

export interface AutomationSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxJobsPerRun: number;
  autoApplyRequested: boolean;
}

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

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  providerKeys: ProviderKey[];
  context?: UserContext;
  jobs: JobItem[];
  rankedJobs: RankedJob[];
  drafts: DraftApplication[];
  applyRecords: ApplyRecord[];
  linkedinConnected: boolean;
  automation: AutomationSettings;
}

export type SessionEvent =
  | { type: "status"; message: string; at: number }
  | { type: "phase"; phase: "context" | "scan" | "rank" | "draft" | "done"; message: string; at: number }
  | { type: "scan_line"; line: string; at: number }
  | { type: "job_found"; job: JobItem; at: number }
  | { type: "scan_done"; count: number; at: number }
  | { type: "autopilot_started"; at: number }
  | { type: "autopilot_ranked"; count: number; at: number }
  | { type: "autopilot_draft"; draft: DraftApplication; at: number }
  | { type: "autopilot_blocked"; message: string; at: number }
  | { type: "error"; message: string; at: number };
