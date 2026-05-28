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
  /** LLM provider keys attached to the session (first one wins for downstream calls). */
  providers?: ProviderKey[];
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
  /** Optional 0-5 evaluation grade (spec dimensions). Computed lazily. */
  evaluation?: JobEvaluation;
}

/**
 * Structured evaluation across the 10 weighted dimensions defined in the
 * autonomous career-ops spec. All sub-scores are 0-5; final score is weighted.
 */
export interface JobEvaluation {
  /** Weighted final score, 0-5 */
  score: number;
  /** Letter grade A+/A/A-/B+ .. F */
  grade: string;
  /** apply | save_for_review | maybe_later | reject */
  recommendation: "apply" | "save_for_review" | "maybe_later" | "reject";
  reasoningSummary: string;
  risks: string[];
  missingInformation: string[];
  applicationStrategy: string;
  /** Per-dimension 0-5 sub-scores (optional, populated by LLM scorer) */
  dimensions?: {
    skill?: number;
    experience?: number;
    seniority?: number;
    domain?: number;
    location?: number;
    compensation?: number;
    visa?: number;
    growth?: number;
    interviewProbability?: number;
    strategic?: number;
  };
}

export interface DraftApplication {
  jobUrl: string;
  company: string;
  title: string;
  coverLetter: string;
  shortPitch: string;
  status: "prepared" | "skipped" | "needs_user_input";
  note: string;
  /** List of missing required fields when status === needs_user_input */
  missingFields?: string[];
}

export interface AutomationSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxJobsPerRun: number;
  autoApplyRequested: boolean;
  /** Per-session policy override (falls back to global config.applyPolicy). */
  policy?: ApplyPolicy;
}

export interface ApplyPolicy {
  minApplyScore?: number;
  allowAutoSubmit?: boolean;
  dryRun?: boolean;
  safeMode?: boolean;
  maxApplicationsPerDay?: number;
}

export type AtsType = "greenhouse" | "lever" | "ashby" | "unknown";

/**
 * Canonical application states. Aligns with the autonomous spec so each job
 * can be filtered, retried, or paused without information loss.
 */
export type ApplyStatus =
  | "submitted"
  | "failed"
  | "unsupported"
  | "evaluated"
  | "saved_for_review"
  | "ready_to_apply"
  | "applying"
  | "blocked_below_threshold"
  | "blocked_needs_login"
  | "blocked_needs_user_input"
  | "blocked_captcha"
  | "blocked_dry_run"
  | "blocked_safe_mode"
  | "failed_retrying"
  | "failed_final";

export interface ApplyRecord {
  jobUrl: string;
  company: string;
  title: string;
  ats: AtsType;
  status: ApplyStatus;
  message: string;
  submittedAt: number;
  /** Score at the time of decision (0-100 ranking or 0-5 evaluation). */
  score?: number;
  /** Optional list of fields the user needs to provide to unblock. */
  needsUserInput?: string[];
  /** Retry counter for failed_retrying / failed_final transitions. */
  retryCount?: number;
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
  | { type: "apply_blocked"; jobUrl: string; reason: string; score?: number; at: number }
  | { type: "needs_user_input"; jobUrl: string; fields: string[]; at: number }
  | { type: "error"; message: string; at: number };
