/**
 * AutoApplyService — self-improving AI agent for job applications.
 *
 * Each attempt:
 *  1. Loads accumulated ATS knowledge (learned extra fields, lessons).
 *  2. Submits to the ATS API with any previously-learned extra fields merged in.
 *  3. On failure: calls the LLM to analyse the error, extracts a lesson +
 *     any missing required fields, saves both to ApplyMemory, then retries once.
 *  4. Records every outcome so the memory graph grows over time.
 *
 * Supported: Greenhouse · Lever · Ashby · unknown (returns manual-apply link)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { applyMemory } from "./applyMemory.js";
import type { ApplyRecord, AtsType, DraftApplication, ProviderKey } from "../types.js";

// ── Contact info extraction ───────────────────────────────────────────────────

export interface CandidateInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export function extractCandidateInfo(cvText: string): CandidateInfo {
  const emailMatch = cvText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = cvText.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const firstLine = cvText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const nameMatch = firstLine.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/);
  const fullName = nameMatch ? nameMatch[1].trim() : "Candidate";
  const nameParts = fullName.split(/\s+/);
  return {
    firstName: nameParts[0] ?? "Candidate",
    lastName: nameParts.slice(1).join(" "),
    email: emailMatch ? emailMatch[0] : "",
    phone: phoneMatch ? phoneMatch[0] : "",
  };
}

// ── ATS detection ─────────────────────────────────────────────────────────────

export function detectAts(url: string): AtsType {
  if (/greenhouse\.io/i.test(url)) return "greenhouse";
  if (/lever\.co/i.test(url)) return "lever";
  if (/ashbyhq\.com|ashby\.io/i.test(url)) return "ashby";
  return "unknown";
}

// ── LLM failure analyser ──────────────────────────────────────────────────────

interface LlmLesson {
  lesson: string;
  extraFields: Record<string, unknown>;
  retryable: boolean;
}

async function analyseFailureWithLlm(
  ats: string,
  errorBody: string,
  providerKey: ProviderKey,
): Promise<LlmLesson> {
  const fallback: LlmLesson = { lesson: "Error not analysed", extraFields: {}, retryable: false };
  const prompt = `You are an ATS integration expert. A job application API call to "${ats}" failed.
Error: ${errorBody.slice(0, 800)}

Return JSON with:
- lesson: string (≤120 chars) — what to remember for future attempts
- extraFields: object — additional body fields to include next time to fix this error
  Greenhouse examples: {"custom_fields":{"ethnicity":"decline_to_state"},"education":[],"employments":[]}
  Lever examples: {"consent":true}
- retryable: boolean — whether adding extraFields would likely succeed on retry
Only return valid JSON.`;

  try {
    if (providerKey.provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerKey.apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini", temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: "Return only valid JSON." }, { role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = JSON.parse(d.choices?.[0]?.message?.content ?? "{}") as Partial<LlmLesson>;
      return {
        lesson: typeof parsed.lesson === "string" ? parsed.lesson.slice(0, 120) : "Unknown error",
        extraFields: (typeof parsed.extraFields === "object" && parsed.extraFields !== null) ? parsed.extraFields as Record<string, unknown> : {},
        retryable: parsed.retryable === true,
      };
    }
    if (providerKey.provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": providerKey.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest", max_tokens: 400, temperature: 0.2,
          system: "Return only valid JSON.",
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = await r.json() as { content?: Array<{ text?: string }> };
      const parsed = JSON.parse(d.content?.[0]?.text ?? "{}") as Partial<LlmLesson>;
      return {
        lesson: typeof parsed.lesson === "string" ? parsed.lesson.slice(0, 120) : "Unknown error",
        extraFields: (typeof parsed.extraFields === "object" && parsed.extraFields !== null) ? parsed.extraFields as Record<string, unknown> : {},
        retryable: parsed.retryable === true,
      };
    }
  } catch { /* fallthrough */ }
  return fallback;
}

// ── Greenhouse ────────────────────────────────────────────────────────────────

function parseGreenhouseUrl(url: string): { boardToken: string; jobId: string } | null {
  const match = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (!match) return null;
  return { boardToken: match[1], jobId: match[2] };
}

async function submitGreenhouse(
  boardToken: string, jobId: string, candidate: CandidateInfo,
  coverLetter: string, resumePath: string, extra: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const resumeB64 = (await fs.readFile(resumePath)).toString("base64");
  const clB64 = Buffer.from(coverLetter, "utf8").toString("base64");
  const payload = {
    first_name: candidate.firstName,
    last_name: candidate.lastName || candidate.firstName,
    email: candidate.email,
    phone: candidate.phone,
    resume_content: resumeB64,
    resume_content_filename: "resume.pdf",
    cover_letter_content: clB64,
    cover_letter_content_filename: "cover_letter.txt",
    ...extra,
  };
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  let body = ""; try { body = await r.text(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body };
}

// ── Lever ─────────────────────────────────────────────────────────────────────

function parseLeverUrl(url: string): { postingId: string } | null {
  const match = url.match(/lever\.co\/[^/?#]+\/([a-zA-Z0-9-]+)/i);
  if (!match) return null;
  return { postingId: match[1] };
}

async function submitLever(
  postingId: string, candidate: CandidateInfo,
  coverLetter: string, resumePath: string, extra: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const resumeBuffer = await fs.readFile(resumePath);
  const form = new FormData();
  form.append("name", `${candidate.firstName} ${candidate.lastName}`.trim());
  form.append("email", candidate.email);
  form.append("phone", candidate.phone);
  form.append("comments", coverLetter);
  form.append("resume", new Blob([resumeBuffer], { type: "application/pdf" }), "resume.pdf");
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const r = await fetch(`https://api.lever.co/v0/postings/${postingId}/apply`, {
    method: "POST", body: form, signal: AbortSignal.timeout(30_000),
  });
  let body = ""; try { body = await r.text(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body };
}

// ── Ashby ─────────────────────────────────────────────────────────────────────

function parseAshbyPostingId(url: string): string | null {
  const match = url.match(/ashby(?:hq\.com|\.io)\/[^/?#]+\/([a-zA-Z0-9-]+)/i);
  return match ? match[1] : null;
}

async function submitAshby(
  jobPostingId: string, candidate: CandidateInfo,
  coverLetter: string, resumePath: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const resumeB64 = (await fs.readFile(resumePath)).toString("base64");
  const fieldSubmissions = [
    { path: "_systemfield_name", value: `${candidate.firstName} ${candidate.lastName}`.trim() },
    { path: "_systemfield_email", value: candidate.email },
    { path: "_systemfield_phone", value: candidate.phone },
    { path: "_systemfield_resume", value: { content: resumeB64, filename: "resume.pdf" } },
    { path: "_systemfield_coverletter", value: coverLetter },
  ];
  const r = await fetch("https://api.ashbyhq.com/applicationForm.submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobPostingId, fieldSubmissions }),
    signal: AbortSignal.timeout(30_000),
  });
  let body = ""; try { body = await r.text(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body };
}

// ── Resume path resolver ──────────────────────────────────────────────────────

async function resolveResumePath(): Promise<string | null> {
  const candidates = [
    path.join(config.repoRoot, "cv", "startup_v4.pdf"),
    path.join(config.repoRoot, "cv", "resume.pdf"),
  ];
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch { /* not found */ }
  }
  try {
    const files = await fs.readdir(path.join(config.repoRoot, "cv"));
    const pdf = files.find((f) => f.endsWith(".pdf"));
    if (pdf) return path.join(config.repoRoot, "cv", pdf);
  } catch { /* no cv dir */ }
  return null;
}

// ── Main service ──────────────────────────────────────────────────────────────

export class AutoApplyService {
  /**
   * Submit an application using the best available strategy.
   * Uses accumulated memory to include previously-learned required fields.
   * On failure calls the LLM, stores the lesson, and retries once.
   */
  async submitApplication(
    draft: DraftApplication,
    cvText: string,
    providerKey?: ProviderKey,
  ): Promise<ApplyRecord> {
    const ats = detectAts(draft.jobUrl);
    const submittedAt = Date.now();
    const mk = (status: ApplyRecord["status"], message: string): ApplyRecord =>
      ({ jobUrl: draft.jobUrl, company: draft.company, title: draft.title, ats, status, message, submittedAt });

    const candidate = extractCandidateInfo(cvText);
    if (!candidate.email) return mk("failed", "No email found in CV — add your email and retry.");

    const resumePath = await resolveResumePath();
    if (!resumePath) return mk("failed", "No resume PDF found. Add a PDF to apps/realtime-web/cv/.");

    // Load accumulated knowledge for this ATS (includes any learned extra fields)
    const knowledge = await applyMemory.getAtsKnowledge(ats);
    const extra = knowledge.requiredExtraFields;

    // Helper: fail → analyse → retry once
    const failWithRetry = async (
      submitFn: (e: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: string }>,
    ): Promise<ApplyRecord> => {
      let r = await submitFn(extra);
      if (r.ok) { await applyMemory.recordAttempt(draft.jobUrl, ats, true); return mk("submitted", "Application submitted."); }

      if (providerKey) {
        const lesson = await analyseFailureWithLlm(ats, `HTTP ${r.status}: ${r.body}`, providerKey);
        await applyMemory.recordAttempt(draft.jobUrl, ats, false, {
          error: `HTTP ${r.status}: ${r.body.slice(0, 300)}`,
          lesson: lesson.lesson,
          extraFields: lesson.extraFields,
        });
        if (lesson.retryable && Object.keys(lesson.extraFields).length > 0) {
          r = await submitFn({ ...extra, ...lesson.extraFields });
          if (r.ok) {
            await applyMemory.recordAttempt(draft.jobUrl, ats, true, { lesson: `Retry after: ${lesson.lesson}` });
            return mk("submitted", `Submitted after self-correction — learned: ${lesson.lesson}`);
          }
          await applyMemory.recordAttempt(draft.jobUrl, ats, false, { error: `Retry HTTP ${r.status}` });
          return mk("failed", `Retry also failed (${r.status}). Lesson saved: ${lesson.lesson}`);
        }
        return mk("failed", `Rejected (${r.status}) — Agent learned: ${lesson.lesson} — Apply manually if needed.`);
      }

      await applyMemory.recordAttempt(draft.jobUrl, ats, false, { error: `HTTP ${r.status}: ${r.body.slice(0, 300)}` });
      return mk("failed", `API returned ${r.status}: ${r.body.slice(0, 250)}`);
    };

    if (ats === "greenhouse") {
      const parsed = parseGreenhouseUrl(draft.jobUrl);
      if (!parsed) { await applyMemory.recordAttempt(draft.jobUrl, ats, false, { error: "URL parse fail" }); return mk("failed", "Could not extract board token / job ID from Greenhouse URL."); }
      return failWithRetry((e) => submitGreenhouse(parsed.boardToken, parsed.jobId, candidate, draft.coverLetter, resumePath, e));
    }

    if (ats === "lever") {
      const parsed = parseLeverUrl(draft.jobUrl);
      if (!parsed) { await applyMemory.recordAttempt(draft.jobUrl, ats, false, { error: "URL parse fail" }); return mk("failed", "Could not extract posting ID from Lever URL."); }
      return failWithRetry((e) => submitLever(parsed.postingId, candidate, draft.coverLetter, resumePath, e));
    }

    if (ats === "ashby") {
      const postingId = parseAshbyPostingId(draft.jobUrl);
      if (!postingId) { await applyMemory.recordUnsupported(draft.jobUrl, ats); return mk("unsupported", "Could not parse Ashby posting ID."); }
      const r = await submitAshby(postingId, candidate, draft.coverLetter, resumePath);
      if (r.ok) { await applyMemory.recordAttempt(draft.jobUrl, ats, true); return mk("submitted", "Application submitted via Ashby API."); }
      if (providerKey) {
        const lesson = await analyseFailureWithLlm(ats, `HTTP ${r.status}: ${r.body}`, providerKey);
        await applyMemory.recordAttempt(draft.jobUrl, ats, false, { error: `HTTP ${r.status}`, lesson: lesson.lesson });
        return mk("failed", `Ashby rejected (${r.status}) — Agent learned: ${lesson.lesson}`);
      }
      await applyMemory.recordUnsupported(draft.jobUrl, ats);
      return mk("unsupported", "Ashby requires manual application for this posting.");
    }

    await applyMemory.recordUnsupported(draft.jobUrl, "unknown");
    return mk("unsupported", "No auto-apply API for this board. Click 'Apply manually' to open the listing.");
  }
}
