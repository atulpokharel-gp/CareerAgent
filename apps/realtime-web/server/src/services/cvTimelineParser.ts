/**
 * CV Timeline Parser
 *
 * Extracts work experience and education from raw CV text using an LLM,
 * returning structured data for the client-side tree visualization.
 */

import type { ProviderKey } from "../types.js";

export interface ExperienceEntry {
  company: string;
  role: string;
  startYear: number;
  endYear: number | null; // null = "Present"
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

// ── LLM helpers (same pattern as cvAtsOptimizer) ────────────────────────────

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
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
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
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

// ── Main parser ──────────────────────────────────────────────────────────────

export async function parseCvTimeline(
  cvText: string,
  providerKey: ProviderKey,
): Promise<CvTimeline> {
  const currentYear = new Date().getFullYear();

  const prompt = `You are a CV parsing expert. Extract ALL work experience and education from this CV.

CV TEXT:
${cvText.slice(0, 8000)}

Return ONLY valid JSON (no markdown):
{
  "experience": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "startYear": 2020,
      "endYear": null,
      "description": "One sentence summary of key responsibilities/achievements"
    }
  ],
  "education": [
    {
      "institution": "University Name",
      "degree": "B.S. / M.S. / Ph.D. / etc.",
      "field": "Computer Science",
      "year": 2018
    }
  ],
  "careerGoals": "2-3 sentence career goals statement derived from this person's trajectory, skills, and experience pattern"
}

Rules:
- Use ${currentYear} as the reference year for "Present" end dates (set endYear to null for current roles)
- Order experience from most recent to oldest
- Order education from most recent to oldest
- Extract EVERY job, even short ones
- careerGoals must be specific and tailored to their actual background
- Return only what's clearly stated in the CV, don't invent companies or dates`;

  const raw = await callLlm(providerKey, prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in timeline parse response");

  const parsed = JSON.parse(match[0]) as {
    experience?: Array<{
      company?: string;
      role?: string;
      startYear?: number;
      endYear?: number | null;
      description?: string;
    }>;
    education?: Array<{
      institution?: string;
      degree?: string;
      field?: string;
      year?: number;
    }>;
    careerGoals?: string;
  };

  const experience: ExperienceEntry[] = (parsed.experience ?? []).map((e) => {
    const start = Number(e.startYear ?? currentYear);
    const end = e.endYear === null || e.endYear === undefined ? null : Number(e.endYear);
    const duration = Math.max(0.5, (end ?? currentYear) - start);
    return {
      company: String(e.company ?? ""),
      role: String(e.role ?? ""),
      startYear: start,
      endYear: end,
      durationYears: Math.round(duration * 10) / 10,
      description: String(e.description ?? ""),
    };
  });

  const education: EducationEntry[] = (parsed.education ?? []).map((e) => ({
    institution: String(e.institution ?? ""),
    degree: String(e.degree ?? ""),
    field: String(e.field ?? ""),
    year: Number(e.year ?? currentYear),
  }));

  // Calculate total years: from earliest start to now
  const years = experience.map((e) => e.startYear);
  const earliestStart = years.length > 0 ? Math.min(...years) : currentYear;
  const totalYearsExperience = Math.max(0, currentYear - earliestStart);

  return {
    experience,
    education,
    totalYearsExperience,
    careerGoals: String(parsed.careerGoals ?? ""),
  };
}

// ── Quick goals-only generator ───────────────────────────────────────────────

export async function generateCareerGoals(
  cvText: string,
  providerKey: ProviderKey,
): Promise<string> {
  const prompt = `You are a career coach. Read this CV and write a compelling 2-3 sentence career goals statement in first person that:
1. Reflects their actual experience and trajectory
2. Highlights their strongest expertise area
3. States their next career aspiration concisely

CV (first 5000 chars):
${cvText.slice(0, 5000)}

Return ONLY valid JSON:
{"goals": "<the career goals statement>"}`;

  try {
    const raw = await callLlm(providerKey, prompt);
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) return "";
    const parsed = JSON.parse(match[0]) as { goals?: string };
    return String(parsed.goals ?? "").trim();
  } catch {
    return "";
  }
}
