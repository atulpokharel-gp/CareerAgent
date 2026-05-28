import type { SupportedProvider } from "../types.js";

export interface ParsedCvProfile {
  cleanedCv: string;
  skills: string[];
  preferredRoles: string[];
  locations: string[];
  goals: string;
  summary: string;
}

const EMPTY_MARKERS = new Set(["", "n/a", "na", "none", "unknown", "not specified", "null", "undefined"]);

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeItem(value: string): string {
  return value.replace(/[•*]/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeList(values: string[], cvText: string, requireGrounding: boolean): string[] {
  const seen = new Set<string>();
  const lowerCv = cvText.toLowerCase();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = normalizeItem(String(rawValue));
    const lowerValue = value.toLowerCase();
    if (EMPTY_MARKERS.has(lowerValue)) continue;
    if (value.length < 2 || value.length > 80) continue;
    if (requireGrounding && !lowerCv.includes(lowerValue)) continue;
    if (seen.has(lowerValue)) continue;
    seen.add(lowerValue);
    result.push(value);
  }

  return result;
}

function sanitizeGoals(goals: string, cvText: string): string {
  const cleaned = normalizeWhitespace(goals);
  if (!cleaned) return "";
  const lowerCv = cvText.toLowerCase();
  const groundedSignals = ["summary", "objective", "profile", "about", "seeking", "looking for", "interested in"];
  const hasGrounding = groundedSignals.some((signal) => lowerCv.includes(signal));
  if (!hasGrounding) {
    return "";
  }
  return cleaned.slice(0, 300);
}

function sanitizeSummary(summary: string): string {
  const cleaned = normalizeWhitespace(summary);
  if (!cleaned || EMPTY_MARKERS.has(cleaned.toLowerCase())) return "";
  return cleaned.slice(0, 320);
}

function extractJsonObject(text: string): ParsedCvProfile {
  const trimmed = text.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Model did not return JSON output");
  }

  const parsed = JSON.parse(trimmed.slice(first, last + 1)) as Partial<ParsedCvProfile>;
  const cleanedCv = typeof parsed.cleanedCv === "string" ? normalizeWhitespace(parsed.cleanedCv) : "";
  return {
    cleanedCv,
    skills: Array.isArray(parsed.skills) ? dedupeList(parsed.skills.map(String).slice(0, 40), cleanedCv, true) : [],
    // preferredRoles: no strict grounding — roles may be inferred from job history
    // and might not appear as exact substrings (e.g. "ML Engineer" vs "Machine Learning Engineer").
    preferredRoles: Array.isArray(parsed.preferredRoles) ? dedupeList(parsed.preferredRoles.map(String).slice(0, 20), cleanedCv, false) : [],
    locations: Array.isArray(parsed.locations) ? dedupeList(parsed.locations.map(String).slice(0, 20), cleanedCv, true) : [],
    goals: typeof parsed.goals === "string" ? sanitizeGoals(parsed.goals, cleanedCv) : "",
    summary: typeof parsed.summary === "string" ? sanitizeSummary(parsed.summary) : "",
  };
}

function buildPrompt(cvText: string): string {
  return [
    "You are an expert career assistant.",
    "Parse the following CV and return STRICT JSON only (no markdown, no explanation).",
    "JSON schema:",
    "{",
    "  \"cleanedCv\": string,",
    "  \"skills\": string[],",
    "  \"preferredRoles\": string[],",
    "  \"locations\": string[],",
    "  \"goals\": string,",
    "  \"summary\": string",
    "}",
    "Rules:",
    "- cleanedCv should be normalized plain text CV content.",
    "- Only include information explicitly present in the CV text or directly quoted from it.",
    "- Never invent, guess, infer, extrapolate, or add likely preferences.",
    "- If a field is not clearly present in the CV, return an empty string or empty array for that field.",
    "- skills should be concise, deduplicated, and explicitly present in the CV.",
    "- preferredRoles: extract EVERY distinct job title this person has held, listed in their CV, or",
    "  mentioned in their objective/summary section. Also include generalised role types clearly",
    "  implied by their career trajectory (e.g. if all jobs are 'Machine Learning Engineer', include",
    "  that title). Return SHORT canonical titles like 'Machine Learning Engineer', 'Data Scientist',",
    "  'Backend Engineer' — not full sentences. Aim for 3-8 roles. Never return an empty array if",
    "  the CV contains any job titles or experience descriptions.",
    "- locations should only contain locations or remote preferences explicitly present in the CV.",
    "- goals should only be filled if the CV explicitly states a goal/objective/profile target.",
    "- summary should be a 2-3 line executive profile summary.",
    "CV:",
    cvText.slice(0, 32000),
  ].join("\n");
}

async function parseOpenAI(apiKey: string, cvText: string): Promise<ParsedCvProfile> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: buildPrompt(cvText) },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI parse failed (${response.status})`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || "";
  return extractJsonObject(content);
}

async function parseAnthropic(apiKey: string, cvText: string): Promise<ParsedCvProfile> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 1800,
      temperature: 0.2,
      system: "Return only JSON.",
      messages: [{ role: "user", content: buildPrompt(cvText) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic parse failed (${response.status})`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  const content = data.content?.[0]?.text || "";
  return extractJsonObject(content);
}

async function parseGemini(apiKey: string, cvText: string): Promise<ParsedCvProfile> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
      contents: [{ role: "user", parts: [{ text: buildPrompt(cvText) }] }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini parse failed (${response.status})`);
  }

  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return extractJsonObject(content);
}

async function parseOpenRouter(apiKey: string, cvText: string): Promise<ParsedCvProfile> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: buildPrompt(cvText) },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter parse failed (${response.status})`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || "";
  return extractJsonObject(content);
}

export async function parseCvWithLlm(input: {
  provider: SupportedProvider;
  apiKey: string;
  cvText: string;
}): Promise<ParsedCvProfile> {
  if (!input.cvText || input.cvText.trim().length < 20) {
    throw new Error("CV text is too short to parse");
  }

  if (input.provider === "openai") {
    return parseOpenAI(input.apiKey, input.cvText);
  }
  if (input.provider === "anthropic") {
    return parseAnthropic(input.apiKey, input.cvText);
  }
  if (input.provider === "gemini") {
    return parseGemini(input.apiKey, input.cvText);
  }
  return parseOpenRouter(input.apiKey, input.cvText);
}
