/**
 * CvVisualizer — AI-themed SVG visualization of CV skills + stats
 * Shows: skill radar chart, experience stats, keyword density heatmap
 */

interface CvVisualizerProps {
  cv: string;
  skills: string;
  atsScore: number | null;
  timeline?: {
    totalYearsExperience: number;
    experience: { company: string; title: string; startYear: number; endYear: number | null }[];
    education: { institution: string; degree: string; startYear: number; endYear: number | null }[];
  } | null;
}

// ── Parse skills from CV text ──────────────────────────────────────────────
const TECH_KEYWORDS = [
  "Python", "TypeScript", "JavaScript", "React", "Node.js", "FastAPI", "Fastify",
  "LangChain", "LangGraph", "OpenAI", "GPT", "LLM", "RAG", "Vector", "Embeddings",
  "PostgreSQL", "MongoDB", "Redis", "Docker", "Kubernetes", "AWS", "GCP", "Azure",
  "ML", "Deep Learning", "NLP", "AI", "Agent", "Automation", "API", "REST", "GraphQL",
  "Rust", "Go", "Java", "C++", "SQL", "Git", "CI/CD", "Terraform",
];

function countKeyword(text: string, kw: string): number {
  const re = new RegExp(`\\b${kw}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

function getTopKeywords(text: string, n = 12): { kw: string; count: number }[] {
  return TECH_KEYWORDS
    .map((kw) => ({ kw, count: countKeyword(text, kw) }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ── Radar chart ──────────────────────────────────────────────────────────
const RADAR_AXES = ["AI/LLM", "Backend", "Frontend", "Data", "Cloud", "Automation"];

function scoreRadar(cv: string): number[] {
  const groups: Record<string, string[]> = {
    "AI/LLM": ["LLM", "GPT", "Agent", "LangChain", "LangGraph", "RAG", "Embeddings", "NLP", "AI", "OpenAI", "ML"],
    "Backend": ["Python", "Node.js", "Fastify", "FastAPI", "REST", "API", "GraphQL", "SQL"],
    "Frontend": ["React", "TypeScript", "JavaScript", "CSS", "HTML", "Vite", "Next.js"],
    "Data":     ["PostgreSQL", "MongoDB", "Redis", "Vector", "Embeddings", "SQL", "Pandas", "Spark"],
    "Cloud":    ["AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform", "CI/CD"],
    "Automation": ["Automation", "Agent", "Workflow", "Pipeline", "Orchestration", "Script"],
  };
  const lower = cv.toLowerCase();
  return RADAR_AXES.map((axis) => {
    const hits = (groups[axis] ?? []).filter((kw) => lower.includes(kw.toLowerCase())).length;
    const max = (groups[axis] ?? []).length;
    return Math.min(100, Math.round((hits / max) * 100));
  });
}

function radarPath(scores: number[], cx: number, cy: number, r: number): string {
  const n = scores.length;
  const points = scores.map((s, i) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const dist = (s / 100) * r;
    return [cx + dist * Math.cos(angle), cy + dist * Math.sin(angle)];
  });
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + " Z";
}

function radarAxisEndpoint(idx: number, n: number, cx: number, cy: number, r: number) {
  const angle = (idx / n) * 2 * Math.PI - Math.PI / 2;
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

export function CvVisualizer({ cv, skills, atsScore, timeline }: CvVisualizerProps) {
  const combined = `${cv}\n${skills}`;
  const scores = scoreRadar(combined);
  const topKeywords = getTopKeywords(combined);
  const totalWords = cv.trim().split(/\s+/).length;
  const expYears = timeline?.totalYearsExperience ?? 0;
  const roleCount = timeline?.experience.length ?? 0;
  const eduCount = timeline?.education.length ?? 0;

  const cx = 110, cy = 110, r = 80;
  const n = RADAR_AXES.length;

  // ATS color
  const atsColor = atsScore === null ? "#6b7280"
    : atsScore >= 85 ? "#00ff88"
    : atsScore >= 70 ? "#f59e0b"
    : "#ef4444";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "1.25rem", alignItems: "start" }}>

      {/* ── Radar Chart ── */}
      <div>
        <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--green)", opacity: 0.7, margin: "0 0 0.5rem" }}>Skill Profile</p>
        <svg viewBox="0 0 220 220" width="100%" style={{ overflow: "visible" }}>
          {/* Grid rings */}
          {[20, 40, 60, 80, 100].map((pct) => (
            <polygon key={pct}
              points={RADAR_AXES.map((_, i) => {
                const [x, y] = radarAxisEndpoint(i, n, cx, cy, r * pct / 100);
                return `${x},${y}`;
              }).join(" ")}
              fill="none"
              stroke={pct === 100 ? "rgba(0,255,136,0.2)" : "rgba(0,255,136,0.08)"}
              strokeWidth={pct === 100 ? 1 : 0.5}
            />
          ))}
          {/* Axes */}
          {RADAR_AXES.map((axis, i) => {
            const [x, y] = radarAxisEndpoint(i, n, cx, cy, r);
            const [lx, ly] = radarAxisEndpoint(i, n, cx, cy, r + 20);
            return (
              <g key={axis}>
                <line x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(0,255,136,0.15)" strokeWidth={0.8} />
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fontFamily="JetBrains Mono, monospace" fill="rgba(0,255,136,0.7)">
                  {axis}
                </text>
              </g>
            );
          })}
          {/* Filled area */}
          <path d={radarPath(scores, cx, cy, r)}
            fill="rgba(0,255,136,0.12)"
            stroke="rgba(0,255,136,0.7)"
            strokeWidth={1.5}
          />
          {/* Score dots */}
          {scores.map((s, i) => {
            const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
            const dist = (s / 100) * r;
            const x = cx + dist * Math.cos(angle);
            const y = cy + dist * Math.sin(angle);
            return (
              <circle key={i} cx={x} cy={y} r={3}
                fill="var(--green)"
                style={{ filter: "drop-shadow(0 0 4px #00ff88)" }}
              />
            );
          })}
        </svg>
      </div>

      {/* ── Right column: stats + heatmap ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

        {/* Stats row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem" }}>
          {[
            { label: "ATS Score", value: atsScore !== null ? `${atsScore}/100` : "—", color: atsColor },
            { label: "Exp. Years", value: expYears > 0 ? `${expYears}y` : "—", color: "var(--cyan)" },
            { label: "Roles", value: roleCount || "—", color: "var(--purple)" },
            { label: "CV Words", value: totalWords > 0 ? `~${(totalWords / 100).toFixed(1)}k` : "—", color: "var(--amber)" },
          ].map((s) => (
            <div key={s.label} style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(0,255,136,0.1)", borderRadius: "0.5rem", padding: "0.6rem 0.75rem", textAlign: "center" }}>
              <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: "1.25rem", fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</p>
              <p style={{ margin: "0.2rem 0 0", fontFamily: "var(--mono)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink-2)" }}>{s.label}</p>
            </div>
          ))}
        </div>

        {/* ATS progress bar */}
        {atsScore !== null && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.1em" }}>ATS Compatibility</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", color: atsColor, fontWeight: 700 }}>
                {atsScore >= 85 ? "EXCELLENT" : atsScore >= 70 ? "GOOD" : "NEEDS WORK"}
              </span>
            </div>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${atsScore}%`, background: `linear-gradient(90deg, ${atsColor}, ${atsColor}aa)` }} />
            </div>
          </div>
        )}

        {/* Keyword heatmap */}
        {topKeywords.length > 0 && (
          <div>
            <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--green)", opacity: 0.7, margin: "0 0 0.5rem" }}>Keyword Density</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {topKeywords.map(({ kw, count }) => {
                const maxCount = topKeywords[0]?.count ?? 1;
                const intensity = count / maxCount;
                const bg = `rgba(0,255,136,${0.05 + intensity * 0.25})`;
                const border = `rgba(0,255,136,${0.1 + intensity * 0.4})`;
                return (
                  <div key={kw} style={{
                    padding: "3px 10px",
                    borderRadius: "9999px",
                    background: bg,
                    border: `1px solid ${border}`,
                    fontFamily: "var(--mono)",
                    fontSize: "0.72rem",
                    color: `rgba(0,255,136,${0.5 + intensity * 0.5})`,
                    fontWeight: intensity > 0.7 ? 700 : 400,
                  }}>
                    {kw} <span style={{ opacity: 0.5 }}>×{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Radar scores bar list */}
        <div>
          <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cyan)", opacity: 0.7, margin: "0 0 0.5rem" }}>Dimension Scores</p>
          <div style={{ display: "grid", gap: "0.3rem" }}>
            {RADAR_AXES.map((axis, i) => (
              <div key={axis} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ width: 80, fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)", flexShrink: 0 }}>{axis}</span>
                <div style={{ flex: 1, height: 4, background: "rgba(0,255,136,0.08)", borderRadius: 9999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${scores[i]}%`, background: "linear-gradient(90deg, var(--green), var(--cyan))", borderRadius: 9999, boxShadow: "0 0 6px rgba(0,255,136,0.5)", transition: "width 0.6s ease" }} />
                </div>
                <span style={{ width: 32, textAlign: "right", fontFamily: "var(--mono)", fontSize: "0.68rem", color: "var(--green)" }}>{scores[i]}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
