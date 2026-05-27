import type { FastifyBaseLogger } from "fastify";
import PQueue from "p-queue";
import type { DraftApplication, JobItem, RankedJob, SessionEvent, SessionState } from "../types.js";

function toLowerSet(input: string[]): Set<string> {
  return new Set(input.map((item) => item.trim().toLowerCase()).filter(Boolean));
}

// Words that mean "can work from anywhere" — expanded in both the job location
// field and the user's requested locations.
const REMOTE_SYNONYMS = new Set([
  "remote", "remotely", "work from home", "wfh", "worldwide", "global",
  "anywhere", "fully remote", "fully-remote", "100% remote", "distributed",
  "hybrid", "remote-first", "remote first",
]);

function isRemoteSynonym(text: string): boolean {
  const t = text.toLowerCase();
  for (const syn of REMOTE_SYNONYMS) {
    if (t.includes(syn)) return true;
  }
  return false;
}

/**
 * Returns true when the job location is acceptable given the user's preferred
 * locations list. Rules (in order):
 *
 * 1. If the user has NO location preferences → accept all jobs.
 * 2. If the user includes "remote" (or any synonym) as a preference AND the
 *    job location is also remote-flavoured (or blank/unknown) → accept.
 * 3. If any user location hint appears as a substring of the job location → accept.
 * 4. Otherwise → reject.
 */
function locationMatches(jobLocation: string, locationHints: Set<string>): boolean {
  if (locationHints.size === 0) return true;

  const loc = jobLocation.trim().toLowerCase();

  // Accept jobs with empty/unknown location when user is open to remote
  const userWantsRemote = [...locationHints].some((h) => REMOTE_SYNONYMS.has(h));
  if (userWantsRemote && (loc === "" || loc === "n/a" || loc === "unknown" || isRemoteSynonym(loc))) {
    return true;
  }

  // Direct substring match for every hint the user specified
  for (const hint of locationHints) {
    if (loc.includes(hint)) return true;
    // Also check the reverse: if hint is a remote synonym, check job location too
    if (REMOTE_SYNONYMS.has(hint) && isRemoteSynonym(loc)) return true;
  }

  return false;
}

function rankJobs(jobs: JobItem[], session: SessionState, maxJobs: number): RankedJob[] {
  const roleHints = toLowerSet(session.context?.preferredRoles || []);
  const locationHints = toLowerSet(session.context?.locations || []);
  const skillHints = toLowerSet((session.context?.skills || "").split(/[\n,]/));

  const ranked = jobs
    // ── Location filter: only keep jobs that satisfy the user's location prefs ──
    .filter((job) => locationMatches(job.location, locationHints))
    .map((job) => {
      let score = 0;
      const reasons: string[] = [];
      const title = job.title.toLowerCase();
      const location = job.location.toLowerCase();

      for (const hint of roleHints) {
        if (title.includes(hint)) {
          score += 35;
          reasons.push(`Role match: ${hint}`);
        }
      }

      for (const hint of locationHints) {
        const matchedSynonym = REMOTE_SYNONYMS.has(hint) && isRemoteSynonym(location);
        if (location.includes(hint) || matchedSynonym) {
          score += 25;
          reasons.push(`Location match: ${hint}`);
          break; // count location bonus once
        }
      }

      for (const hint of skillHints) {
        if (hint && title.includes(hint)) {
          score += 10;
          reasons.push(`Skill overlap: ${hint}`);
        }
      }

      if (job.url.includes("greenhouse") || job.url.includes("lever") || job.url.includes("ashby")) {
        score += 10;
        reasons.push("ATS-compatible endpoint");
      }

      return {
        ...job,
        score: Math.min(score, 100),
        reasons,
      };
    });

  return ranked.sort((a, b) => b.score - a.score).slice(0, Math.max(1, maxJobs));
}

function buildDraft(session: SessionState, job: RankedJob): DraftApplication {
  const cvExcerpt = (session.context?.cv || "").slice(0, 800);
  const goals = session.context?.goals || "";
  const shortPitch = `I align with ${job.title} based on ${session.context?.skills || "relevant applied AI experience"}.`;
  const coverLetter = [
    `Dear ${job.company} Hiring Team,`,
    "",
    `I am applying for the ${job.title} role.`,
    shortPitch,
    `My goals: ${goals}`,
    "",
    "Selected profile excerpt:",
    cvExcerpt,
    "",
    "Regards,",
    "Candidate",
  ].join("\n");

  let status: DraftApplication["status"] = "prepared";
  let note = "Application package prepared for autonomous pipeline.";

  if (job.url.includes("linkedin.com")) {
    status = "skipped";
    note = "Skipped submission: LinkedIn anti-bot and policy controls require interactive verification.";
  }

  return {
    jobUrl: job.url,
    company: job.company,
    title: job.title,
    coverLetter,
    shortPitch,
    status,
    note,
  };
}

export class AutopilotRunner {
  private readonly queue = new PQueue({ concurrency: 6 });

  run(params: {
    session: SessionState;
    verify: boolean;
    company?: string;
    scan: () => Promise<JobItem[]>;
    onEvent: (event: SessionEvent) => void;
    logger: FastifyBaseLogger;
  }): Promise<{ ranked: RankedJob[]; drafts: DraftApplication[] }> {
    return this.queue.add(async () => {
      params.onEvent({ type: "autopilot_started", at: Date.now() });
      const jobs = await params.scan();
      const ranked = rankJobs(jobs, params.session, params.session.automation.maxJobsPerRun);
      params.onEvent({ type: "autopilot_ranked", count: ranked.length, at: Date.now() });

      const drafts: DraftApplication[] = [];
      for (const job of ranked) {
        const draft = buildDraft(params.session, job);
        drafts.push(draft);
        params.onEvent({ type: "autopilot_draft", draft, at: Date.now() });
      }

      if (params.session.automation.autoApplyRequested) {
        params.onEvent({
          type: "autopilot_blocked",
          message: "Final submission remains blocked by safety policy. Drafts are prepared automatically.",
          at: Date.now(),
        });
      }

      return { ranked, drafts };
    }) as Promise<{ ranked: RankedJob[]; drafts: DraftApplication[] }>;
  }
}
