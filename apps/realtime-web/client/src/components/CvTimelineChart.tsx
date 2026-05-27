/**
 * CvTimelineChart
 *
 * SVG-based Gantt chart of work experience + education.
 * - Indigo bars = work experience
 * - Green  bars = education
 * - Orange shading = employment gap (≥ 6 months)
 * - Red outline = overlapping roles (two jobs same time)
 */

import type { CvTimeline, ExperienceEntry, EducationEntry } from "../lib/api";

interface Props {
  timeline: CvTimeline;
}

const COLORS = {
  exp: "#00ff88",
  expText: "rgba(0,255,136,0.85)",
  edu: "#00d4ff",
  eduText: "rgba(0,212,255,0.85)",
  gap: "rgba(245,158,11,0.08)",
  gapBorder: "#f59e0b",
  overlap: "#ef4444",
  axis: "rgba(0,255,136,0.15)",
  axisText: "rgba(0,255,136,0.45)",
  bg: "transparent",
};

const BAR_H = 26;
const ROW_GAP = 6;
const LABEL_W = 160;
const RIGHT_PAD = 16;
const AXIS_H = 28;

interface Bar {
  label: string;       // "Company · Role" or "Degree · Institution"
  startYear: number;
  endYear: number;     // current year if null
  type: "exp" | "edu";
  overlap: boolean;
}

interface GapSpan {
  startYear: number;
  endYear: number;
}

function detectGaps(exps: ExperienceEntry[], now: number): GapSpan[] {
  if (exps.length < 2) return [];
  const sorted = [...exps].sort((a, b) => a.startYear - b.startYear);
  const gaps: GapSpan[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].endYear ?? now;
    const curr = sorted[i].startYear;
    if (curr - prev >= 0.5) {
      gaps.push({ startYear: prev, endYear: curr });
    }
  }
  return gaps;
}

function detectOverlaps(exps: ExperienceEntry[], now: number): Set<string> {
  const overlapping = new Set<string>();
  for (let i = 0; i < exps.length; i++) {
    for (let j = i + 1; j < exps.length; j++) {
      const aStart = exps[i].startYear;
      const aEnd = exps[i].endYear ?? now;
      const bStart = exps[j].startYear;
      const bEnd = exps[j].endYear ?? now;
      if (aStart < bEnd && bStart < aEnd) {
        overlapping.add(`${exps[i].company}-${exps[i].role}`);
        overlapping.add(`${exps[j].company}-${exps[j].role}`);
      }
    }
  }
  return overlapping;
}

export function CvTimelineChart({ timeline }: Props) {
  const now = new Date().getFullYear();

  const allYears = [
    ...timeline.experience.map((e) => e.startYear),
    ...timeline.experience.map((e) => e.endYear ?? now),
    ...timeline.education.map((e) => e.year),
  ];
  if (allYears.length === 0) return null;

  const minYear = Math.min(...allYears) - 0.5;
  const maxYear = now + 0.5;
  const span = maxYear - minYear;

  const overlapping = detectOverlaps(timeline.experience, now);
  const gaps = detectGaps(timeline.experience, now);

  const bars: Bar[] = [
    ...timeline.experience.map((e): Bar => ({
      label: `${e.company} · ${e.role}`,
      startYear: e.startYear,
      endYear: e.endYear ?? now,
      type: "exp",
      overlap: overlapping.has(`${e.company}-${e.role}`),
    })),
    ...timeline.education.map((e): Bar => ({
      label: `${e.degree} · ${e.institution}`,
      startYear: e.year,
      endYear: e.year + 4,
      type: "edu",
      overlap: false,
    })),
  ].sort((a, b) => a.startYear - b.startYear);

  const chartH = bars.length * (BAR_H + ROW_GAP) + AXIS_H + 8;
  const totalW = 700;
  const barAreaW = totalW - LABEL_W - RIGHT_PAD;

  function toX(year: number) {
    return LABEL_W + ((year - minYear) / span) * barAreaW;
  }

  // Year axis ticks
  const tickYears: number[] = [];
  const step = span > 15 ? 5 : span > 8 ? 2 : 1;
  for (let y = Math.ceil(minYear); y <= Math.floor(maxYear); y += step) {
    tickYears.push(y);
  }

  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
      <svg
        viewBox={`0 0 ${totalW} ${chartH}`}
        style={{ width: "100%", maxWidth: totalW, display: "block", fontFamily: "inherit" }}
      >
        {/* Gap spans */}
        {gaps.map((g, i) => (
          <rect
            key={`gap-${i}`}
            x={toX(g.startYear)}
            y={0}
            width={toX(g.endYear) - toX(g.startYear)}
            height={chartH - AXIS_H}
            fill={COLORS.gap}
            stroke={COLORS.gapBorder}
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.7}
          />
        ))}
        {gaps.map((g, i) => (
          <text
            key={`gap-label-${i}`}
            x={(toX(g.startYear) + toX(g.endYear)) / 2}
            y={10}
            textAnchor="middle"
            fontSize={9}
            fill={COLORS.gapBorder}
          >
            gap
          </text>
        ))}

        {/* Bars */}
        {bars.map((bar, i) => {
          const y = i * (BAR_H + ROW_GAP) + 4;
          const x1 = toX(bar.startYear);
          const x2 = toX(bar.endYear);
          const w = Math.max(x2 - x1, 6);
          const color = bar.type === "exp" ? COLORS.exp : COLORS.edu;
          const textColor = bar.type === "exp" ? COLORS.expText : COLORS.eduText;
          const truncLabel = bar.label.length > 24 ? bar.label.slice(0, 22) + "…" : bar.label;

          return (
            <g key={`bar-${i}`}>
              {/* Label */}
              <text
                x={LABEL_W - 6}
                y={y + BAR_H / 2 + 4}
                textAnchor="end"
                fontSize={10}
                fill={textColor}
              >
                {truncLabel}
              </text>
              {/* Bar */}
              <rect
                x={x1}
                y={y}
                width={w}
                height={BAR_H}
                rx={4}
                fill={color}
                opacity={0.85}
                stroke={bar.overlap ? COLORS.overlap : "none"}
                strokeWidth={bar.overlap ? 2 : 0}
              />
              {/* Year range inside bar if wide enough */}
              {w > 32 && (
                <text
                  x={x1 + 6}
                  y={y + BAR_H / 2 + 4}
                  fontSize={9}
                  fill="#fff"
                  opacity={0.9}
                >
                  {bar.startYear}–{bar.endYear === now ? "Now" : bar.endYear}
                </text>
              )}
              {/* Overlap marker */}
              {bar.overlap && (
                <text
                  x={x2 + 3}
                  y={y + BAR_H / 2 + 4}
                  fontSize={9}
                  fill={COLORS.overlap}
                >
                  ⚠ overlap
                </text>
              )}
            </g>
          );
        })}

        {/* Axis line */}
        <line
          x1={LABEL_W}
          y1={chartH - AXIS_H}
          x2={totalW - RIGHT_PAD}
          y2={chartH - AXIS_H}
          stroke={COLORS.axis}
          strokeWidth={1}
        />

        {/* Tick marks & labels */}
        {tickYears.map((y) => (
          <g key={`tick-${y}`}>
            <line
              x1={toX(y)}
              y1={chartH - AXIS_H}
              x2={toX(y)}
              y2={chartH - AXIS_H + 5}
              stroke={COLORS.axisText}
              strokeWidth={1}
            />
            <text
              x={toX(y)}
              y={chartH - 6}
              textAnchor="middle"
              fontSize={10}
              fill={COLORS.axisText}
            >
              {y}
            </text>
          </g>
        ))}

        {/* "Now" marker */}
        <line
          x1={toX(now)}
          y1={0}
          x2={toX(now)}
          y2={chartH - AXIS_H}
          stroke="#6366f1"
          strokeWidth={1.5}
          strokeDasharray="5 3"
          opacity={0.5}
        />
        <text
          x={toX(now) - 3}
          y={16}
          textAnchor="end"
          fontSize={9}
          fill="#a78bfa"
        >
          now
        </text>
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", gap: "1rem", fontSize: "0.72rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COLORS.exp, verticalAlign: "middle", marginRight: 4 }} />Work experience</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COLORS.edu, verticalAlign: "middle", marginRight: 4 }} />Education</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COLORS.gap, border: `1px dashed ${COLORS.gapBorder}`, verticalAlign: "middle", marginRight: 4 }} />Employment gap</span>
        <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, border: `2px solid ${COLORS.overlap}`, verticalAlign: "middle", marginRight: 4 }} />Overlapping roles</span>
      </div>
    </div>
  );
}
