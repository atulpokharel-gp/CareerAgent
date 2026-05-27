/**
 * CV ATS Optimizer
 *
 * Scores a CV against ATS criteria (0-100) and returns an optimized
 * version that targets 85+. Used automatically in the pipeline when
 * the initial score falls below the threshold.
 *
 * Scoring rubric:
 *  - Standard section headers            15 pts
 *  - Keyword density vs target roles     25 pts
 *  - Quantified achievements             20 pts
 *  - Action-verb bullet openings         15 pts
 *  - Contact info completeness           10 pts
 *  - No broken-parser characters         10 pts
 *  - Clean formatting / conciseness       5 pts
 */

import type { ProviderKey } from "../types.js";

export interface AtsOptimizeResult {
  /** Estimated ATS score of the original CV (0–100) */
  originalScore: number;
  /** Estimated ATS score after optimization (0–100) */
  optimizedScore: number;
  /** ATS-optimized CV text */
  optimizedCv: string;
  /** List of issues found and fixed */
  issues: string[];
  /** Keywords added or strengthened */
  keywordsAdded: string[];
  /** Whether optimization was needed (originalScore < threshold) */
  wasOptimized: boolean;
}

const ATS_TARGET_SCORE = 85;

// ── LLM call helpers ──────────────────────────────────────────────────────────

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { text: string }[] };
  return data.content[0]?.text ?? "";
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
  return data.candidates[0]?.content?.parts?.[0]?.text ?? "";
}

async function callLlm(providerKey: ProviderKey, prompt: string): Promise<string> {
  const { provider, apiKey } = providerKey;
  if (provider === "openai" || provider === "openrouter") return callOpenAI(apiKey, prompt);
  if (provider === "anthropic") return callAnthropic(apiKey, prompt);
  if (provider === "gemini") return callGemini(apiKey, prompt);
  throw new Error(`Unsupported provider: ${provider}`);
}

// ── JSON extraction ───────────────────────────────────────────────────────────

function extractJson(raw: string): AtsOptimizeResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in LLM response");
  const parsed = JSON.parse(match[0]) as Partial<AtsOptimizeResult>;
  return {
    originalScore: Number(parsed.originalScore ?? 0),
    optimizedScore: Number(parsed.optimizedScore ?? 0),
    optimizedCv: String(parsed.optimizedCv ?? ""),
    issues: Array.isArray(parsed.issues) ? (parsed.issues as string[]) : [],
    keywordsAdded: Array.isArray(parsed.keywordsAdded) ? (parsed.keywordsAdded as string[]) : [],
    wasOptimized: Boolean(parsed.wasOptimized ?? false),
  };
}

// ── Main optimizer ────────────────────────────────────────────────────────────

export async function optimizeCvForAts(
  cvText: string,
  targetRoles: string[],
  providerKey: ProviderKey,
  jobDescription?: string,
): Promise<AtsOptimizeResult> {
  const rolesStr = targetRoles.length > 0 ? targetRoles.join(", ") : "Software Engineer";
  const jdSection = jobDescription
    ? `\n\nJOB DESCRIPTION TO MATCH:\n${jobDescription.slice(0, 2000)}`
    : "";

  const prompt = `You are a world-class ATS (Applicant Tracking System) optimization expert.
Your task: analyze the candidate's CV, score it, then return a fully optimized version that scores ${ATS_TARGET_SCORE}+ out of 100.

TARGET ROLES: ${rolesStr}${jdSection}

=== ORIGINAL CV ===
${cvText.slice(0, 8000)}
=== END CV ===

ATS SCORING RUBRIC (total 100 pts):
1. Standard section headers (Work Experience/Experience, Education, Skills/Technical Skills, Summary/Profile) — 15 pts
2. Keyword density: how well role-relevant technical skills and domain keywords appear — 25 pts
3. Quantified achievements: bullet points with numbers, %, time frames, scale — 20 pts
4. Action verbs: every bullet/responsibility starts with a strong past-tense action verb — 15 pts
5. Contact info: name, email, phone present and parseable — 10 pts
6. Clean text: no tables, no Unicode symbols that break parsers, no graphics references — 10 pts
7. Formatting/length: concise, scannable, no walls of text — 5 pts

OPTIMIZATION RULES:
- Keep ALL factual information true to the original — never invent metrics or companies
- Only ADD context/numbers that are clearly implied (e.g., if they mention "team of 5" somewhere)
- Strengthen existing bullet points to start with action verbs: Led, Built, Designed, Reduced, Increased, Deployed, Automated, Implemented, Optimized, Delivered
- Add missing high-value keywords from the target roles that you can reasonably infer belong based on context
- Rename non-standard sections to standard ATS headers
- If contact info is missing key fields, add placeholder format (e.g., "[phone]")
- Remove tables and replace with plain text
- Keep the CV to the original approximate length (do not drastically shorten)

Return ONLY valid JSON (no markdown, no explanation outside the JSON):
{
  "originalScore": <number 0-100>,
  "issues": [<list of specific issues found, each ≤80 chars>],
  "optimizedCv": "<full optimized CV text, preserving ALL real data>",
  "optimizedScore": <estimated score 0-100 after optimization>,
  "keywordsAdded": [<keywords added or strengthened>],
  "wasOptimized": <true if any changes were made>
}`;

  const raw = await callLlm(providerKey, prompt);
  const result = extractJson(raw);

  // Validate: never return empty optimizedCv
  if (!result.optimizedCv || result.optimizedCv.length < 50) {
    result.optimizedCv = cvText;
    result.wasOptimized = false;
    result.optimizedScore = result.originalScore;
  }

  return result;
}

// ── Score-only quick check ────────────────────────────────────────────────────
// Lightweight: just returns the score without a full rewrite. Used for the UI badge.

export async function scoreAts(
  cvText: string,
  targetRoles: string[],
  providerKey: ProviderKey,
): Promise<{ score: number; issues: string[] }> {
  const rolesStr = targetRoles.length > 0 ? targetRoles.join(", ") : "Software Engineer";
  const prompt = `You are an ATS scoring expert.
Score this CV against ATS criteria on a scale of 0-100 for target roles: ${rolesStr}

CV (first 4000 chars):
${cvText.slice(0, 4000)}

Criteria:
- Standard headers (Experience, Education, Skills, Summary) — 15 pts
- Relevant keyword density — 25 pts
- Quantified achievements — 20 pts
- Action-verb bullet openings — 15 pts
- Contact info completeness — 10 pts
- No parser-breaking characters — 10 pts
- Clean formatting — 5 pts

Return ONLY valid JSON:
{"score": <0-100>, "issues": [<up to 5 most impactful issues, each ≤80 chars>]}`;

  const raw = await callLlm(providerKey, prompt);
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return { score: 70, issues: [] };
  const parsed = JSON.parse(match[0]) as { score?: number; issues?: string[] };
  return {
    score: Number(parsed.score ?? 70),
    issues: Array.isArray(parsed.issues) ? (parsed.issues as string[]) : [],
  };
}
