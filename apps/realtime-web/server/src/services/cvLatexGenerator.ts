/**
 * CV LaTeX + HTML Generator
 *
 * Uses an LLM to rewrite a CV as:
 *  1. Professional LaTeX (moderncv style) — for Overleaf or pdflatex
 *  2. Print-ready HTML — open in browser, Ctrl+P → Save as PDF
 *
 * Saved to output/ with a timestamp prefix.
 * Served via GET /api/output/:filename.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { ProviderKey } from "../types.js";

export interface LatexCvResult {
  texFileName: string;
  htmlFileName: string;
  texDownloadUrl: string;
  htmlDownloadUrl: string;
  /** The raw LaTeX string (useful for display) */
  latexContent: string;
}

const OUTPUT_DIR = config.outputDir;

// ── LLM helpers ───────────────────────────────────────────────────────────────

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
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
      max_tokens: 4096,
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

// ── LaTeX generation ──────────────────────────────────────────────────────────

async function generateLatex(
  cvText: string,
  targetRole: string,
  providerKey: ProviderKey,
): Promise<string> {
  const prompt = `You are an expert LaTeX CV writer. Convert this CV into clean, compilable LaTeX using the moderncv package (classic style, blue color).

TARGET ROLE: ${targetRole || "Software Engineer"}

ORIGINAL CV:
${cvText.slice(0, 7000)}

Requirements:
- Use \\documentclass[11pt,a4paper]{moderncv} and \\moderncvstyle{classic} \\moderncvcolor{blue}
- Include all standard sections: \\section{Summary}, \\section{Experience}, \\section{Education}, \\section{Skills}
- Use \\cventry{years}{title}{company}{location}{}{description} for experience
- Use \\cventry{year}{degree}{institution}{}{}{} for education
- Use \\cvitem{category}{items} for skills
- Keep ALL real data from the CV — never invent information
- Make bullet points concise and ATS-optimized
- End with \\end{document}

Return ONLY the raw LaTeX code, starting with \\documentclass. No markdown fences, no explanation.`;

  const latex = await callLlm(providerKey, prompt);
  // Strip any accidental markdown code fences
  return latex
    .replace(/^```(?:latex|tex)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── HTML generation (print-to-PDF) ───────────────────────────────────────────

async function generateHtml(
  cvText: string,
  targetRole: string,
  providerKey: ProviderKey,
): Promise<string> {
  const prompt = `You are an expert CV writer and web developer. Convert this CV into a standalone, print-ready HTML page.

TARGET ROLE: ${targetRole || "Software Engineer"}

ORIGINAL CV:
${cvText.slice(0, 7000)}

Requirements:
- Single-file HTML with embedded CSS (no external dependencies)
- Professional, ATS-friendly layout — clean sans-serif font, good whitespace
- Sections: Header (name/contact), Summary, Experience, Education, Skills
- Print-friendly: @media print CSS that fits on A4/Letter, removes browser chrome
- Color scheme: white background, dark text, subtle blue accents for headings
- Include a "Save as PDF" print button (hidden in print media)
- Keep ALL real data from the CV
- Make it look like a real professional CV (not a wall of text)

Return ONLY the full HTML starting with <!DOCTYPE html>. No markdown, no explanation.`;

  const html = await callLlm(providerKey, prompt);
  // Strip any accidental markdown code fences
  return html
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

// ── Main generator ────────────────────────────────────────────────────────────

export async function generateLatexCv(
  cvText: string,
  targetRole: string,
  providerKey: ProviderKey,
  slug?: string,
): Promise<LatexCvResult> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const ts = Date.now();
  const prefix = slug
    ? `${ts}-${slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`
    : String(ts);

  const [latex, html] = await Promise.all([
    generateLatex(cvText, targetRole, providerKey),
    generateHtml(cvText, targetRole, providerKey),
  ]);

  const texFileName = `cv-${prefix}.tex`;
  const htmlFileName = `cv-${prefix}.html`;

  await Promise.all([
    fs.writeFile(path.join(OUTPUT_DIR, texFileName), latex, "utf8"),
    fs.writeFile(path.join(OUTPUT_DIR, htmlFileName), html, "utf8"),
  ]);

  return {
    texFileName,
    htmlFileName,
    texDownloadUrl: `/api/output/${texFileName}`,
    htmlDownloadUrl: `/api/output/${htmlFileName}`,
    latexContent: latex,
  };
}
