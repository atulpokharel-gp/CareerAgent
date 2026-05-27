/**
 * CV Chatbot Service
 *
 * A conversational interface for editing and improving the CV.
 * The LLM has full CV context and responds with:
 *   - A prose reply explaining changes
 *   - (Optionally) an updated CV block if the user asked for an edit
 */

import type { ProviderKey } from "../types.js";
import { appendChatMessage } from "./persistentStorage.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface ChatResponse {
  reply: string;
  updatedCv: string | null;  // non-null when the CV was modified
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

async function callLlm(providerKey: ProviderKey, messages: { role: string; content: string }[]): Promise<string> {
  const { provider, apiKey } = providerKey;

  if (provider === "openai" || provider === "openrouter") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.4, messages }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const userMsgs = messages.filter((m) => m.role !== "system");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 2048, system, messages: userMsgs }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = (await res.json()) as { content: { text: string }[] };
    return data.content[0]?.text ?? "";
  }

  if (provider === "gemini") {
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    return data.candidates[0]?.content?.parts?.[0]?.text ?? "";
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// ── Main chat function ────────────────────────────────────────────────────────

export async function chatWithCv(
  currentCv: string,
  history: ChatMessage[],
  userMessage: string,
  providerKey: ProviderKey,
): Promise<ChatResponse> {
  const systemPrompt = `You are a professional CV/resume editor and career coach.
The user has given you their current CV. Help them improve it, rewrite sections, add keywords for ATS, or answer questions about their career.

CURRENT CV:
---
${currentCv.slice(0, 8000)}
---

Rules:
- If the user asks you to EDIT, REWRITE, ADD, REMOVE or CHANGE something in the CV, return your reply AND wrap the COMPLETE updated CV in <updated_cv>...</updated_cv> tags.
- If the user only asks a question or asks for advice (no edits needed), just reply normally — do NOT include the <updated_cv> block.
- Keep your prose reply concise (2-4 sentences).
- When rewriting, keep ALL original information — never remove real experience or education.
- Format the CV clearly with standard Markdown sections.`;

  const llmMessages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const rawReply = await callLlm(providerKey, llmMessages);

  // Extract updated CV if present
  const cvMatch = rawReply.match(/<updated_cv>([\s\S]*?)<\/updated_cv>/);
  const updatedCv = cvMatch ? cvMatch[1].trim() : null;
  const reply = rawReply.replace(/<updated_cv>[\s\S]*?<\/updated_cv>/g, "").trim();

  // Persist to chat history
  await appendChatMessage("user", userMessage).catch(() => {});
  await appendChatMessage("assistant", reply).catch(() => {});

  return { reply, updatedCv };
}
