/**
 * WorkflowService — Full end-to-end job-search pipeline
 *
 * Steps (all streamed via SSE):
 *   1. PARSE   — LLM extracts skills, roles, locations, timeline, goals from CV
 *   2. SCAN    — scan portals for matching jobs (location + role filtered)
 *   3. OPTIMIZE — for each job: score ATS → loop-optimize until 85+ (max 3 tries)
 *   4. GENERATE — create LaTeX + HTML CV per job
 *   5. APPLY   — submit; on failure: LLM analyses error → retries once
 *   6. SAVE    — persist everything to user-data.json
 */

import type { FastifyBaseLogger } from "fastify";
import type { ProviderKey, SessionState, SessionEvent, DraftApplication, JobItem } from "../types.js";
import { parseCvWithLlm } from "./llmCvParser.js";
import { parseCvTimeline } from "./cvTimelineParser.js";
import { optimizeCvForAts } from "./cvAtsOptimizer.js";
import { generateLatexCv } from "./cvLatexGenerator.js";
import { submitApplication } from "./autoApplyService.js";
import {
  addCvVersion, upsertApplication, saveTimeline,
  type ApplicationRecord,
} from "./persistentStorage.js";

export type WorkflowPhase =
  | "idle" | "parse" | "scan" | "optimize" | "generate" | "apply" | "done" | "error";

export type WorkflowEvent =
  | { type: "wf_phase"; phase: WorkflowPhase; message: string; at: number }
  | { type: "wf_progress"; step: string; detail: string; at: number }
  | { type: "wf_job_ready"; jobUrl: string; company: string; title: string; atsScore: number; latexUrl: string | null; htmlUrl: string | null; at: number }
  | { type: "wf_apply_result"; jobUrl: string; status: "submitted" | "failed" | "unsupported"; message: string; at: number }
  | { type: "wf_done"; totalJobs: number; submitted: number; failed: number; at: number }
  | { type: "wf_error"; message: string; at: number };

export interface WorkflowOptions {
  session: SessionState;
  cv: string;
  providerKey: ProviderKey;
  autoApply: boolean;
  maxJobs: number;
  onEvent: (event: SessionEvent | WorkflowEvent) => void;
  logger: FastifyBaseLogger;
  scan: () => Promise<JobItem[]>;
}

const emit = (opts: WorkflowOptions, event: SessionEvent | WorkflowEvent) => opts.onEvent(event);

const phase = (opts: WorkflowOptions, p: WorkflowPhase, msg: string) =>
  emit(opts, { type: "wf_phase", phase: p, message: msg, at: Date.now() });

const progress = (opts: WorkflowOptions, step: string, detail: string) =>
  emit(opts, { type: "wf_progress", step, detail, at: Date.now() });

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runWorkflow(opts: WorkflowOptions): Promise<void> {
  const { cv, providerKey, autoApply, maxJobs } = opts;

  try {
    // ── Step 1: PARSE ─────────────────────────────────────────────────────────
    phase(opts, "parse", "Parsing CV with AI — extracting skills, roles, goals, timeline…");
    progress(opts, "parse", "Calling LLM to extract structured data…");

    const [parsed, timeline] = await Promise.all([
      parseCvWithLlm(cv, providerKey.provider, providerKey.apiKey),
      parseCvTimeline(cv, providerKey),
    ]);

    progress(opts, "parse", `Found ${parsed.skills.length} skills · ${parsed.preferredRoles.length} roles · ${timeline.experience.length} jobs`);

    // Save timeline to persistent storage
    await saveTimeline(timeline).catch(() => {/* non-blocking */});

    // Save original CV version
    const originalVersion = await addCvVersion({
      label: "original",
      content: cv,
      atsScore: null,
      targetRole: null,
      latexUrl: null,
      htmlUrl: null,
    }).catch(() => null);

    // ── Step 2: SCAN ──────────────────────────────────────────────────────────
    phase(opts, "scan", "Scanning job portals for matching positions…");
    progress(opts, "scan", "Running portal scan (Greenhouse · Lever · Ashby)…");

    const jobs = await opts.scan();
    progress(opts, "scan", `Found ${jobs.length} raw jobs`);

    if (jobs.length === 0) {
      phase(opts, "done", "No jobs found matching your location/role criteria");
      emit(opts, { type: "wf_done", totalJobs: 0, submitted: 0, failed: 0, at: Date.now() });
      return;
    }

    // Use top N jobs by location+role relevance (already filtered by autopilotRunner logic)
    const targetJobs = jobs.slice(0, Math.min(maxJobs, jobs.length));
    progress(opts, "scan", `Processing top ${targetJobs.length} matching jobs`);

    // ── Steps 3–5: Per-job: OPTIMIZE → GENERATE → APPLY ─────────────────────
    phase(opts, "optimize", `Optimizing CV for ${targetJobs.length} jobs (targeting ATS ≥ 85)…`);

    let submitted = 0;
    let failed = 0;

    for (const job of targetJobs) {
      progress(opts, "optimize", `[${job.company}] Scoring ATS for "${job.title}"…`);

      // --- 3. Optimize CV (up to 3 iterations until score ≥ 85) ---------------
      let currentCv = cv;
      let atsScore = 0;
      let iterations = 0;
      const maxIterations = 3;

      try {
        while (iterations < maxIterations) {
          iterations++;
          const result = await optimizeCvForAts(
            currentCv,
            parsed.preferredRoles,
            providerKey,
            `${job.company} ${job.title}`,
          );

          atsScore = result.optimizedScore;
          currentCv = result.optimizedCv;

          progress(opts, "optimize",
            `[${job.company}] Iter ${iterations}: ATS ${result.originalScore}→${atsScore}/100` +
            (atsScore >= 85 ? " ✓ Target reached" : ` — retry ${iterations}/${maxIterations}`));

          if (atsScore >= 85) break;
        }
      } catch (e) {
        progress(opts, "optimize", `[${job.company}] ATS optimization failed: ${(e as Error).message}`);
        // continue with original CV
        currentCv = cv;
        atsScore = 0;
      }

      // --- 4. Generate LaTeX + HTML CV ---------------------------------------
      phase(opts, "generate", `[${job.company}] Generating tailored CV…`);
      let latexUrl: string | null = null;
      let htmlUrl: string | null = null;

      try {
        const slug = `${job.company}-${job.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
        const latexResult = await generateLatexCv(currentCv, job.title, providerKey, slug);
        latexUrl = latexResult.texDownloadUrl;
        htmlUrl = latexResult.htmlDownloadUrl;

        // Persist this CV version
        await addCvVersion({
          label: `ats-optimized-for-${job.company.replace(/\s+/g, "-").toLowerCase()}`,
          content: currentCv,
          atsScore,
          targetRole: job.title,
          latexUrl,
          htmlUrl,
        }).catch(() => null);

        progress(opts, "generate", `[${job.company}] CV generated: HTML + LaTeX ready`);
      } catch (e) {
        progress(opts, "generate", `[${job.company}] CV generation failed: ${(e as Error).message}`);
      }

      emit(opts, {
        type: "wf_job_ready",
        jobUrl: job.url,
        company: job.company,
        title: job.title,
        atsScore,
        latexUrl,
        htmlUrl,
        at: Date.now(),
      });

      // --- 5. Apply (with auto-retry on LLM-diagnosed failures) -------------
      if (!autoApply) {
        progress(opts, "apply", `[${job.company}] Auto-apply disabled — job ready for manual review`);

        await upsertApplication({
          jobUrl: job.url,
          company: job.company,
          jobTitle: job.title,
          jobLocation: job.location,
          title: job.title,
          ats: "unknown",
          status: "unsupported",
          message: "Queued for manual apply",
          submittedAt: Date.now(),
          cvVersionId: originalVersion?.id ?? null,
          atsScore,
          notes: `ATS score: ${atsScore}/100`,
        }).catch(() => null);

        continue;
      }

      phase(opts, "apply", `[${job.company}] Submitting application…`);

      const draft: DraftApplication = {
        jobUrl: job.url,
        company: job.company,
        title: job.title,
        coverLetter: buildCoverLetter(job, currentCv, parsed.preferredRoles),
        shortPitch: `Experienced ${parsed.preferredRoles[0] ?? "professional"} applying for ${job.title} at ${job.company}.`,
        status: "prepared",
        note: "",
      };

      const applyRecord = await submitApplication(draft, providerKey, currentCv);

      emit(opts, {
        type: "wf_apply_result",
        jobUrl: job.url,
        status: applyRecord.status,
        message: applyRecord.message,
        at: Date.now(),
      });

      if (applyRecord.status === "submitted") {
        submitted++;
      } else {
        failed++;
      }

      await upsertApplication({
        ...applyRecord,
        jobTitle: job.title,
        jobLocation: job.location,
        cvVersionId: originalVersion?.id ?? null,
        atsScore,
        notes: `ATS score: ${atsScore}/100`,
      }).catch(() => null);
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    phase(opts, "done", `Workflow complete — ${submitted} submitted · ${failed} failed · ${targetJobs.length - submitted - failed} manual`);
    emit(opts, { type: "wf_done", totalJobs: targetJobs.length, submitted, failed, at: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.logger.error({ err: e }, "Workflow error");
    phase(opts, "error", `Workflow failed: ${msg}`);
    emit(opts, { type: "wf_error", message: msg, at: Date.now() });
  }
}

function buildCoverLetter(job: JobItem, cvExcerpt: string, roles: string[]): string {
  return [
    `Dear ${job.company} Hiring Team,`,
    "",
    `I am excited to apply for the ${job.title} role at ${job.company}.`,
    `As an experienced ${roles[0] ?? "professional"}, I bring relevant expertise that aligns closely with this position.`,
    "",
    "Selected profile:",
    cvExcerpt.slice(0, 600),
    "",
    "I look forward to discussing how I can contribute.",
    "",
    "Best regards,",
    "Candidate",
  ].join("\n");
}
