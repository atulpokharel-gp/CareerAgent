/**
 * CvChatbot
 *
 * A conversational panel for editing the CV.
 * The user types requests ("Add more keywords for ML Engineer roles") and
 * the LLM replies with prose + optionally a full updated CV.
 */

import { useState, useRef, useEffect } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

interface Props {
  cv: string;
  provider: string;
  apiKey: string;
  sessionId: string;
  onCvUpdated: (newCv: string) => void;
}

const BASE = "http://localhost:8787";

export function CvChatbot({ cv, provider, apiKey, sessionId, onCvUpdated }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text, at: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${BASE}/api/session/${sessionId}/cv-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey, cv, message: text, history: messages.slice(-8) }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? `Server error ${res.status}`);
      }

      const data = (await res.json()) as { reply: string; updatedCv: string | null };
      const botMsg: ChatMessage = { role: "assistant", content: data.reply, at: Date.now() };
      setMessages((prev) => [...prev, botMsg]);

      if (data.updatedCv) {
        onCvUpdated(data.updatedCv);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${e instanceof Error ? e.message : "Unknown error"}`, at: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 320 }}>
      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          background: "#0f172a",
          borderRadius: "0.5rem",
          maxHeight: 360,
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#6b7280", fontSize: "0.8rem", margin: "auto", textAlign: "center" }}>
            Ask me to improve your CV — add keywords, rewrite sections, optimize for ATS, or answer career questions.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              padding: "0.5rem 0.75rem",
              borderRadius: m.role === "user" ? "1rem 1rem 0 1rem" : "1rem 1rem 1rem 0",
              background: m.role === "user" ? "#4f46e5" : "#1e293b",
              color: m.role === "user" ? "#e0e7ff" : "#cbd5e1",
              fontSize: "0.82rem",
              whiteSpace: "pre-wrap",
              lineHeight: 1.5,
            }}
          >
            {m.content}
            {m.role === "assistant" && m.content.includes("✓ Updated CV") && (
              <span style={{ marginLeft: "0.4rem", fontSize: "0.75rem", color: "#6ee7b7" }}>CV saved ✓</span>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: "flex-start", color: "#6b7280", fontSize: "0.8rem" }}>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={loading}
          placeholder="e.g. Add more React and TypeScript keywords for senior frontend roles…"
          rows={2}
          style={{
            flex: 1,
            resize: "vertical",
            background: "#1e293b",
            color: "#e2e8f0",
            border: "1px solid #334155",
            borderRadius: "0.5rem",
            padding: "0.5rem",
            fontSize: "0.82rem",
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          disabled={loading || !input.trim()}
          onClick={() => void send()}
          style={{
            padding: "0.5rem 1.2rem",
            borderRadius: "0.5rem",
            border: "none",
            background: loading ? "#374151" : "#4f46e5",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: "0.82rem",
            alignSelf: "flex-end",
          }}
        >
          {loading ? "…" : "Send"}
        </button>
      </div>
      <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "0.25rem" }}>
        Press Enter to send · Shift+Enter for new line · CV edits are applied automatically
      </p>
    </div>
  );
}
