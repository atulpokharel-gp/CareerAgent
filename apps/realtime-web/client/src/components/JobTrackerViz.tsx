/**
 * JobTrackerViz — Real-time job pipeline visualization
 * Shows: funnel chart, status kanban, ATS distribution, apply velocity
 */

import type { ApplyRecord } from "../lib/api";

interface JobTrackerVizProps {
  applyRecords: ApplyRecord[];
  jobs: { url: string; title: string; company: string; location: string }[];
  atsScores: Record<string, { score: number | null }>;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  submitted:   { label: "Applied",     color: "#00ff88", bg: "rgba(0,255,136,0.1)"  },
  failed:      { label: "Failed",      color: "#ef4444", bg: "rgba(239,68,68,0.1)"  },
  unsupported: { label: "Manual",      color: "#f59e0b", bg: "rgba(245,158,11,0.1)" },
  pending:     { label: "Queued",      color: "#00d4ff", bg: "rgba(0,212,255,0.1)"  },
};

function countByStatus(records: ApplyRecord[]) {
  const counts: Record<string, number> = {};
  for (const r of records) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  return counts;
}

// Sparkline helper (last 10 applications by time)
function Sparkline({ records }: { records: ApplyRecord[] }) {
  const sorted = [...records].sort((a, b) => a.submittedAt - b.submittedAt).slice(-14);
  if (sorted.length < 2) return null;
  const w = 200, h = 40, pad = 4;
  const min = Math.min(...sorted.map((r) => r.submittedAt));
  const max = Math.max(...sorted.map((r) => r.submittedAt));
  const range = max - min || 1;
  const points = sorted.map((r, i) => {
    const x = pad + ((r.submittedAt - min) / range) * (w - pad * 2);
    const y = r.status === "submitted" ? h * 0.25 : h * 0.75;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ height: 40 }}>
      <polyline points={points.join(" ")} fill="none" stroke="rgba(0,255,136,0.5)" strokeWidth={1.5} />
      {sorted.map((r, i) => {
        const [x, y] = points[i]!.split(",").map(Number);
        return (
          <circle key={i} cx={x} cy={y} r={2.5}
            fill={r.status === "submitted" ? "var(--green)" : r.status === "failed" ? "var(--red)" : "var(--amber)"}
          />
        );
      })}
    </svg>
  );
}

// Funnel chart
function FunnelChart({ scanned, ranked, applied }: { scanned: number; ranked: number; applied: number }) {
  const stages = [
    { label: "Scanned",  val: scanned,  color: "var(--cyan)",   w: 100 },
    { label: "Shortlisted", val: ranked, color: "var(--purple)", w: scanned > 0 ? Math.round((ranked / scanned) * 100) : 0 },
    { label: "Applied",  val: applied,  color: "var(--green)",  w: scanned > 0 ? Math.round((applied / scanned) * 100) : 0 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {stages.map((s) => (
        <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ width: 80, fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)", flexShrink: 0 }}>{s.label}</span>
          <div style={{ flex: 1, height: 16, background: "rgba(255,255,255,0.03)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
            <div style={{ height: "100%", width: `${s.w}%`, background: s.color, opacity: 0.7, borderRadius: 3, transition: "width 0.8s ease", boxShadow: `0 0 8px ${s.color}88` }} />
          </div>
          <span style={{ width: 28, textAlign: "right", fontFamily: "var(--mono)", fontSize: "0.7rem", color: s.color, fontWeight: 700 }}>{s.val}</span>
        </div>
      ))}
    </div>
  );
}

// ATS distribution mini chart
function AtsDistribution({ scores }: { scores: number[] }) {
  if (scores.length === 0) return <p className="empty">No ATS scores yet</p>;
  const buckets = [
    { label: "90+",  min: 90, max: 100, color: "var(--green)" },
    { label: "80-89", min: 80, max: 89, color: "rgba(0,255,136,0.6)" },
    { label: "70-79", min: 70, max: 79, color: "var(--amber)" },
    { label: "<70",  min: 0,  max: 69, color: "var(--red)" },
  ];
  const max = scores.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      {buckets.map((b) => {
        const count = scores.filter((s) => s >= b.min && s <= b.max).length;
        return (
          <div key={b.label} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ width: 42, fontFamily: "var(--mono)", fontSize: "0.7rem", color: b.color, flexShrink: 0 }}>{b.label}</span>
            <div style={{ flex: 1, height: 10, background: "rgba(255,255,255,0.04)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${max > 0 ? (count / max) * 100 : 0}%`, background: b.color, borderRadius: 3, opacity: 0.8, transition: "width 0.6s" }} />
            </div>
            <span style={{ width: 20, textAlign: "right", fontFamily: "var(--mono)", fontSize: "0.68rem", color: b.color }}>{count}</span>
          </div>
        );
      })}
    </div>
  );
}

export function JobTrackerViz({ applyRecords, jobs, atsScores }: JobTrackerVizProps) {
  const counts = countByStatus(applyRecords);
  const submitted = counts["submitted"] ?? 0;
  const failed = counts["failed"] ?? 0;
  const manual = counts["unsupported"] ?? 0;
  const total = applyRecords.length;
  const successRate = total > 0 ? Math.round((submitted / total) * 100) : 0;
  const allScores = Object.values(atsScores).map((v) => v.score).filter((s): s is number => s !== null);

  const statusEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>

      {/* ── Pipeline Funnel ── */}
      <div>
        <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--cyan)", opacity: 0.8, margin: "0 0 0.75rem" }}>Application Funnel</p>
        <FunnelChart scanned={jobs.length} ranked={jobs.length} applied={submitted} />
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <span className="stat-chip chip-green">✓ {submitted} Applied</span>
          {failed > 0 && <span className="stat-chip chip-red">✗ {failed} Failed</span>}
          {manual > 0 && <span className="stat-chip chip-amber">↗ {manual} Manual</span>}
        </div>
      </div>

      {/* ── Success rate ring ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--purple)", opacity: 0.8, margin: 0 }}>Success Rate</p>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <svg viewBox="0 0 80 80" width={80} height={80} style={{ flexShrink: 0 }}>
            <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(168,85,247,0.1)" strokeWidth={8} />
            <circle cx="40" cy="40" r="34" fill="none"
              stroke="var(--purple)" strokeWidth={8}
              strokeDasharray={`${2 * Math.PI * 34}`}
              strokeDashoffset={`${2 * Math.PI * 34 * (1 - successRate / 100)}`}
              strokeLinecap="round"
              style={{ transform: "rotate(-90deg)", transformOrigin: "40px 40px", transition: "stroke-dashoffset 0.8s ease", filter: "drop-shadow(0 0 6px rgba(168,85,247,0.6))" }}
            />
            <text x="40" y="40" textAnchor="middle" dominantBaseline="middle"
              fontSize={16} fontFamily="JetBrains Mono, monospace" fill="var(--purple)" fontWeight="700">
              {successRate}%
            </text>
          </svg>
          <div>
            <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--ink-2)" }}>
              <span style={{ color: "var(--green)", fontWeight: 700 }}>{submitted}</span> of <span style={{ color: "#fff" }}>{total}</span> submitted
            </p>
            <p style={{ margin: "0.2rem 0 0", fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)" }}>
              {jobs.length} jobs scanned
            </p>
          </div>
        </div>
      </div>

      {/* ── ATS Distribution ── */}
      <div>
        <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--amber)", opacity: 0.8, margin: "0 0 0.6rem" }}>ATS Score Distribution</p>
        <AtsDistribution scores={allScores} />
        {allScores.length > 0 && (
          <p style={{ marginTop: "0.4rem", fontFamily: "var(--mono)", fontSize: "0.7rem", color: "var(--ink-2)" }}>
            Avg: <span style={{ color: "var(--green)", fontWeight: 700 }}>{Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)}/100</span>
          </p>
        )}
      </div>

      {/* ── Application velocity ── */}
      <div>
        <p style={{ fontFamily: "var(--mono)", fontSize: "0.7rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--green)", opacity: 0.8, margin: "0 0 0.6rem" }}>Apply Velocity</p>
        {applyRecords.length >= 2 ? (
          <Sparkline records={applyRecords} />
        ) : (
          <p className="empty">Run applications to see velocity chart</p>
        )}
        {statusEntries.length > 0 && (
          <div style={{ marginTop: "0.5rem", display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
            {statusEntries.map(([status, count]) => {
              const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG["pending"]!;
              return (
                <span key={status} style={{ padding: "2px 8px", borderRadius: 9999, fontFamily: "var(--mono)", fontSize: "0.68rem", background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}55` }}>
                  {cfg.label}: {count}
                </span>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
