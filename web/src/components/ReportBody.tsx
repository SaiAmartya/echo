"use client";
// ReportBody — editorial render of a generated /report payload.
// Lifted verbatim out of /report/page.tsx (S1) so the same component can be
// reused inside the inline /simulating right column. NO chrome (Frame, topbar,
// footer CTAs) lives here — that's page-level. This is just the structured
// body: executive summary + verdict + audience reception + risk vectors +
// rewrite options + comparable discourse.
//
// CONTRACTS v3 §12 / v4 §17 — `mode` discriminator on ReportResponse is
// surfaced via an optional <Badge /> chip rendered by the page that wraps
// this component (see /report/page.tsx). Body itself is mode-agnostic.

import type { Archetype, Report, ReportSeverity, ReportTone, ReportVerdict } from "@/lib/api";
import { Badge, Button, Eyebrow } from "@/components/ui/Primitives";

const ARCHETYPE_COLOR: Record<Archetype, string> = {
  enthusiast: "#7dd49a",
  practitioner: "#9bc97f",
  curious: "#b8b8c0",
  lurker: "#b8b8c0",
  pedant: "#e8b75a",
  skeptic: "#f06c5a",
};

const ARCHETYPE_ORDER: Archetype[] = [
  "skeptic",
  "enthusiast",
  "curious",
  "practitioner",
  "pedant",
  "lurker",
];

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

type BadgeTone = "positive" | "neutral" | "caution" | "danger" | "accent" | "mono";

function toneBadge(tone: ReportTone): BadgeTone {
  switch (tone) {
    case "positive":
      return "positive";
    case "caution":
      return "caution";
    case "danger":
      return "danger";
    case "neutral":
    default:
      return "neutral";
  }
}

function severityBadge(sev: ReportSeverity): BadgeTone {
  switch (sev) {
    case "low":
      return "positive";
    case "medium":
      return "caution";
    case "high":
      return "danger";
    default:
      return "neutral";
  }
}

function verdictBadge(v: ReportVerdict): BadgeTone {
  switch (v) {
    case "ship":
      return "positive";
    case "revise":
      return "caution";
    case "rethink":
      return "danger";
    default:
      return "neutral";
  }
}

export function ReportBody({
  report,
  onUseRewrite,
}: {
  report: Report;
  onUseRewrite: (text: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 1. Executive summary */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderLeft: "2px solid var(--accent-200)",
          borderRadius: 12,
          padding: 28,
        }}
      >
        <p
          style={{
            margin: 0,
            fontFamily: "var(--font-sans)",
            fontSize: 20,
            lineHeight: 1.45,
            color: "var(--fg-1)",
            letterSpacing: "-0.01em",
            fontWeight: 400,
          }}
        >
          {report.executive_summary}
        </p>
      </div>

      {/* 2. Verdict */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <Eyebrow>Verdict</Eyebrow>
        <div>
          <Badge tone={verdictBadge(report.verdict)}>
            {capitalize(report.verdict)}
          </Badge>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--fg-2)",
          }}
        >
          {report.verdict_rationale}
        </p>
      </div>

      {/* 3. Audience reception */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Eyebrow>Audience reception</Eyebrow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {[...report.audience_reception]
            .sort(
              (a, b) =>
                ARCHETYPE_ORDER.indexOf(a.archetype) -
                ARCHETYPE_ORDER.indexOf(b.archetype),
            )
            .map((rec) => (
              <div
                key={rec.archetype}
                style={{
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: ARCHETYPE_COLOR[rec.archetype],
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: "var(--fg-1)",
                    }}
                  >
                    {capitalize(rec.archetype)}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Badge tone={toneBadge(rec.tone)}>{capitalize(rec.tone)}</Badge>
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: "var(--fg-2)",
                  }}
                >
                  {rec.summary}
                </p>
                {rec.representative_quote && (
                  <blockquote
                    style={{
                      margin: 0,
                      paddingLeft: 12,
                      borderLeft: "2px solid var(--border-strong, var(--border))",
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: "var(--fg-2)",
                    }}
                  >
                    “{rec.representative_quote}”
                  </blockquote>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* 4. Risk vectors */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Eyebrow>Risk vectors</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {report.risk_vectors.map((rv, i) => (
            <div
              key={`${rv.label}-${i}`}
              style={{
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Badge tone={severityBadge(rv.severity)}>
                  {capitalize(rv.severity)}
                </Badge>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: "var(--fg-1)",
                  }}
                >
                  {rv.label}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                {rv.detail}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* 5. Rewrite options */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Eyebrow>Rewrite options</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {report.rewrite_options.map((opt, i) => (
            <div
              key={`${opt.label}-${i}`}
              style={{
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <Eyebrow>{opt.label}</Eyebrow>
              <div
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--fg-1)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {opt.text}
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                {opt.rationale}
              </p>
              <div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onUseRewrite(opt.text)}
                >
                  Use this rewrite
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 6. Comparable discourse (optional) */}
      {report.comparable_discourse && report.comparable_discourse.trim() !== "" && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <Eyebrow>Comparable discourse</Eyebrow>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              lineHeight: 1.6,
              color: "var(--fg-2)",
            }}
          >
            {report.comparable_discourse}
          </p>
        </div>
      )}
    </div>
  );
}
