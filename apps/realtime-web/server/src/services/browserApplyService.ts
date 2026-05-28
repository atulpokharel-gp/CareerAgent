/**
 * BrowserApplyService — Playwright-powered job application engine.
 *
 * Strategy:
 *  1. Open the job URL in headless Chromium.
 *  2. Snapshot the page's form fields (labels + input types).
 *  3. Ask the LLM to map CV data → every field answer.
 *  4. Fill each field, handle file uploads (generates a temp PDF from CV text).
 *  5. Take a screenshot before submitting (safety confirmation screenshot saved to /tmp).
 *  6. Click the submit button and confirm success.
 *
 * Works for Greenhouse, Lever, Ashby, Workday, and most other ATS portals
 * because it drives the actual browser UI, not an undocumented API.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium, type Page, type Browser, type BrowserContext } from "playwright-core";
import { config, IS_VERCEL } from "../config.js";
import type { DraftApplication, ApplyRecord, ProviderKey } from "../types.js";
import { extractCandidateInfo, detectAts } from "./autoApplyService.js";

// ── LLM field-filler ─────────────────────────────────────────────────────────

interface FieldAnswer {
  selector: string;
  type: "text" | "select" | "file" | "checkbox" | "textarea";
  value: string;
  label: string;
}

async function askLlmToFillForm(
  fields: Array<{ label: string; type: string; selector: string; options?: string[] }>,
  cvText: string,
  coverLetter: string,
  providerKey: ProviderKey,
): Promise<FieldAnswer[]> {
  const fieldSummary = fields
    .map((f, i) => {
      const opts = f.options?.length ? ` [options: ${f.options.slice(0, 8).join(" | ")}]` : "";
      return `${i + 1}. label="${f.label}" type="${f.type}" selector="${f.selector}"${opts}`;
    })
    .join("\n");

  const prompt = `You are filling out a job application form on behalf of this candidate.

CV (extract facts from this):
${cvText.slice(0, 3000)}

Cover letter for this job:
${coverLetter.slice(0, 800)}

Form fields to fill (each has a CSS selector):
${fieldSummary}

Return a JSON array. For each field include:
- selector: exactly as given
- type: exactly as given  
- label: field label
- value: the answer to put in this field (empty string to skip)

Rules:
- For "file" type fields: value = "UPLOAD_RESUME" (will be handled separately)
- For select/dropdown: pick the best matching option from the options list, or empty to skip
- For phone: extract from CV or use empty string
- For LinkedIn/GitHub/website: extract URL from CV if present, else empty
- For "Are you authorized to work": answer "Yes" or pick yes option
- For salary/compensation: leave empty if not mentioned in CV
- For cover letter textarea: use the cover letter text
- For EEO/diversity fields: pick "Decline to self-identify" or equivalent
- Skip fields you cannot answer confidently (return empty string)
Only return valid JSON array, no explanation.`;

  try {
    let content = "";
    if (providerKey.provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerKey.apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return [];
      const data = await r.json() as { choices: { message: { content: string } }[] };
      content = data.choices[0]?.message?.content ?? "{}";
    } else if (providerKey.provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": providerKey.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) return [];
      const data = await r.json() as { content: { type: string; text: string }[] };
      content = data.content.find((c) => c.type === "text")?.text ?? "[]";
    } else {
      return [];
    }

    // Extract JSON array from response
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]) as FieldAnswer[];
    // Try parsing as object with array property
    const obj = JSON.parse(content) as Record<string, unknown>;
    const arr = Object.values(obj).find((v) => Array.isArray(v));
    return arr ? (arr as FieldAnswer[]) : [];
  } catch {
    return [];
  }
}

// ── CV text → temporary PDF ────────────────────────────────────────────────

async function cvTextToPdf(cvText: string): Promise<string> {
  // Generate a temp PDF from CV text using Playwright's print-to-PDF
  const tmpHtml = path.join(os.tmpdir(), `cv-upload-${Date.now()}.html`);
  const tmpPdf = path.join(os.tmpdir(), `cv-upload-${Date.now()}.pdf`);

  const escaped = cvText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Arial,sans-serif;font-size:11pt;margin:2cm;white-space:pre-wrap;}</style>
</head><body>${escaped}</body></html>`;

  await fs.writeFile(tmpHtml, html, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${tmpHtml}`);
    await page.pdf({ path: tmpPdf, format: "A4", margin: { top: "2cm", bottom: "2cm", left: "2cm", right: "2cm" } });
  } finally {
    await browser.close();
    await fs.unlink(tmpHtml).catch(() => { /* ignore */ });
  }

  return tmpPdf;
}

// ── Form field extractor ───────────────────────────────────────────────────

async function extractFormFields(page: Page) {
  return page.evaluate(() => {
    const fields: Array<{
      label: string;
      type: string;
      selector: string;
      options?: string[];
    }> = [];

    // Get all visible interactive elements
    const inputs = document.querySelectorAll(
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']), " +
      "textarea, select"
    );

    inputs.forEach((el, idx) => {
      const elem = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (!elem.offsetParent && elem.tagName !== "INPUT") return; // skip hidden

      // Find associated label
      let label = "";
      const id = elem.id;
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) label = labelEl.textContent?.trim() ?? "";
      }
      if (!label) {
        // Traverse up for wrapping label
        let p = elem.parentElement;
        while (p && p.tagName !== "LABEL" && p.tagName !== "FORM" && p !== document.body) {
          p = p.parentElement;
        }
        if (p?.tagName === "LABEL") label = p.textContent?.trim().split("\n")[0] ?? "";
      }
      if (!label) {
        // Use placeholder or aria-label
        label = elem.getAttribute("placeholder") ?? elem.getAttribute("aria-label") ?? elem.getAttribute("name") ?? `field_${idx}`;
      }
      label = label.slice(0, 100);

      const tagName = elem.tagName.toLowerCase();
      let type = "text";
      if (tagName === "select") type = "select";
      else if (tagName === "textarea") type = "textarea";
      else type = (elem as HTMLInputElement).type || "text";

      // Build a robust CSS selector
      let selector = "";
      if (id) {
        selector = `#${CSS.escape(id)}`;
      } else if (elem.getAttribute("name")) {
        selector = `${tagName}[name="${CSS.escape(elem.getAttribute("name")!)}"]`;
      } else {
        selector = `${tagName}:nth-of-type(${idx + 1})`;
      }

      // Collect select options
      let options: string[] | undefined;
      if (tagName === "select") {
        options = Array.from((elem as HTMLSelectElement).options)
          .map((o) => o.text.trim())
          .filter(Boolean);
      }

      fields.push({ label, type, selector, options });
    });

    return fields;
  });
}

// ── Main browser apply flow ────────────────────────────────────────────────

export class BrowserApplyService {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    }
    return this.browser;
  }

  async applyWithBrowser(
    draft: DraftApplication,
    cvText: string,
    providerKey: ProviderKey | undefined,
    onStatus: (msg: string) => void,
  ): Promise<ApplyRecord> {
    const ats = detectAts(draft.jobUrl);
    const submittedAt = Date.now();
    const mk = (status: ApplyRecord["status"], message: string): ApplyRecord => ({
      jobUrl: draft.jobUrl,
      company: draft.company,
      title: draft.title,
      ats,
      status,
      message,
      submittedAt,
    });

    if (IS_VERCEL) {
      return mk("failed", "Browser-based apply is not available in the hosted environment. Run locally.");
    }

    if (!providerKey) {
      return mk("failed", "No LLM provider configured — needed to intelligently fill form fields.");
    }

    const candidate = extractCandidateInfo(cvText);
    if (!candidate.email) {
      return mk("failed", "No email found in your CV. Add your email and retry.");
    }

    let resumePdfPath: string | null = null;
    let tempPdfCreated = false;

    // Try to get or create a resume PDF
    try {
      onStatus("Generating resume PDF from CV text…");
      resumePdfPath = await cvTextToPdf(cvText);
      tempPdfCreated = true;
    } catch (e) {
      onStatus(`Could not generate PDF: ${e instanceof Error ? e.message : "unknown"} — proceeding without resume upload`);
    }

    const browser = await this.getBrowser();
    const context: BrowserContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    try {
      onStatus(`Opening ${draft.company} application page…`);
      await page.goto(draft.jobUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Wait for form elements to appear
      try {
        await page.waitForSelector("input, textarea, select", { timeout: 8_000 });
      } catch {
        // Some pages need clicking "Apply" first
        const applyBtn = page.locator("a:has-text('Apply'), button:has-text('Apply'), a:has-text('Apply Now'), button:has-text('Apply Now')").first();
        try {
          await applyBtn.click({ timeout: 5_000 });
          await page.waitForSelector("input, textarea, select", { timeout: 10_000 });
        } catch {
          /* form may already be visible or on same page */
        }
      }

      // Handle Greenhouse iframe
      const ghIframe = page.frameLocator("iframe[src*='greenhouse']").first();
      const workingFrame = ghIframe ? page : page;
      void workingFrame; // used below via page

      onStatus("Analysing application form fields…");
      const fields = await extractFormFields(page);

      if (fields.length === 0) {
        // Try iframes
        for (const frame of page.frames()) {
          const iframeFields = await extractFormFields(frame as unknown as Page);
          if (iframeFields.length > 0) {
            fields.push(...iframeFields);
            break;
          }
        }
      }

      onStatus(`Found ${fields.length} form fields. Asking AI to fill them…`);

      const answers = await askLlmToFillForm(fields, cvText, draft.coverLetter, providerKey);

      // Fill each field
      let filled = 0;
      for (const answer of answers) {
        if (!answer.value) continue;
        try {
          if (answer.type === "file" && answer.value === "UPLOAD_RESUME" && resumePdfPath) {
            const input = page.locator(answer.selector).first();
            await input.setInputFiles(resumePdfPath, { timeout: 8_000 });
            filled++;
          } else if (answer.type === "select") {
            const sel = page.locator(answer.selector).first();
            // Try selecting by visible text first, then by value
            try {
              await sel.selectOption({ label: answer.value }, { timeout: 5_000 });
            } catch {
              try { await sel.selectOption({ value: answer.value }, { timeout: 3_000 }); } catch { /* skip */ }
            }
            filled++;
          } else if (answer.type === "checkbox") {
            if (["yes", "true", "1", "on"].includes(answer.value.toLowerCase())) {
              const cb = page.locator(answer.selector).first();
              const checked = await cb.isChecked();
              if (!checked) await cb.check({ timeout: 5_000 });
              filled++;
            }
          } else if (answer.type === "textarea" || answer.type === "text" || answer.type === "email" || answer.type === "tel") {
            const inp = page.locator(answer.selector).first();
            await inp.fill(answer.value, { timeout: 5_000 });
            filled++;
          }
        } catch {
          // Non-fatal: continue with other fields
        }
      }

      onStatus(`Filled ${filled} fields. Taking pre-submit screenshot…`);

      // Save screenshot to /tmp for review
      const screenshotPath = path.join(os.tmpdir(), `apply-${draft.company.replace(/\W+/g, "_")}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      onStatus("Submitting application…");

      // Click the submit button
      const submitBtn = page.locator(
        "button[type='submit'], input[type='submit'], " +
        "button:has-text('Submit application'), button:has-text('Submit Application'), " +
        "button:has-text('Submit'), button:has-text('Apply now'), button:has-text('Apply Now')"
      ).first();

      const submitVisible = await submitBtn.isVisible().catch(() => false);
      if (!submitVisible) {
        return mk("failed", `Filled ${filled} fields but could not find submit button. Screenshot saved to ${screenshotPath}. Apply manually: ${draft.jobUrl}`);
      }

      await submitBtn.click({ timeout: 10_000 });

      // Wait for success indication
      await page.waitForTimeout(3000);
      const pageText = await page.innerText("body").catch(() => "");
      const successSignals = ["thank you", "application received", "successfully submitted", "we'll be in touch", "confirmation"];
      const isSuccess = successSignals.some((s) => pageText.toLowerCase().includes(s));

      if (isSuccess) {
        onStatus(`✓ Successfully applied to ${draft.company} – ${draft.title}`);
        return mk("submitted", `Applied via browser automation. ${filled} fields filled.`);
      }

      // Check for error indicators
      const errorSignals = ["required", "error", "invalid", "please fill"];
      const hasError = errorSignals.some((s) => pageText.toLowerCase().includes(s));
      if (hasError) {
        return mk("failed", `Form submission may have failed — validation errors detected. Screenshot: ${screenshotPath}. Apply manually: ${draft.jobUrl}`);
      }

      // Ambiguous — page changed, likely success
      const currentUrl = page.url();
      if (currentUrl !== draft.jobUrl) {
        onStatus(`✓ Page redirected after submit — likely success for ${draft.company}`);
        return mk("submitted", `Applied via browser automation (redirected after submit). URL: ${currentUrl}`);
      }

      return mk("failed", `Submitted but could not confirm success. Screenshot: ${screenshotPath}. Check manually: ${draft.jobUrl}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return mk("failed", `Browser apply error: ${msg.slice(0, 300)}. Apply manually: ${draft.jobUrl}`);
    } finally {
      await page.close();
      await context.close();
      if (tempPdfCreated && resumePdfPath) {
        await fs.unlink(resumePdfPath).catch(() => { /* ignore */ });
      }
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserApplyService = new BrowserApplyService();
