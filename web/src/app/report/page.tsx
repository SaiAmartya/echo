"use client";
// Full report page (CONTRACTS v3 §12, §13)
// Renders the structured Gemini-3-thinking report on a single scrollable page.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame } from "@/components/Shell";
import { Badge, Button, Eyebrow, Icon } from "@/components/ui/Primitives";
import {
  api,
  ApiError,
  type Archetype,
  type Report,
  type ReportResponse,
  type ReportSeverity,
  type ReportTone,
  type ReportVerdict,
} from "@/lib/api";
import { RequireAuth } from "@/components/auth/RequireAuth";

// Same hex values used by SwarmThread.tsx CLUSTER_CENTERS — kept local per
// CONTRACTS guidance (do not import from SwarmThread).
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

function ReportInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("Missing simulation id.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await api.generateReport({ simulation_id: id });
        if (cancelled) return;
        setReport(result);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ApiError
            ? `${e.message} (${e.code})`
            : e instanceof Error
              ? e.message
              : "Failed to generate report.";
        setError(msg);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onRegenerate = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.generateReport({
        simulation_id: id,
        regenerate: true,
      });
      setReport(result);
      setLoading(false);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.message} (${e.code})`
          : e instanceof Error
            ? e.message
            : "Failed to regenerate report.";
      setError(msg);
      setLoading(false);
    }
  };

  return (
    <Frame topbarLabel="Full report" sidebarActive="compose">
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {error && (
          <div
            role="alert"
            style={{
              background: "rgba(240,108,90,0.08)",
              border: "1px solid rgba(240,108,90,0.35)",
              color: "#f06c5a",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {loading && !error && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 18,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--fg-3)",
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
                background: "var(--accent-200)",
                animation: "echo-pulse 1.6s var(--ease-in-out) infinite",
              }}
            />
            Generating full report…
          </div>
        )}

        {report && !loading && (
          <ReportBody
            report={report.report}
            onUseRewrite={(text) => {
              if (typeof window !== "undefined") {
                window.sessionStorage.setItem("echo:draft", text);
              }
              router.push("/compose");
            }}
          />
        )}

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <Button
            variant="ghost"
            icon={<Icon name="refresh" size={13} />}
            onClick={onRegenerate}
            disabled={loading || !id}
          >
            Regenerate
          </Button>
          <Button
            variant="ghost"
            icon={<Icon name="replies" size={13} />}
            onClick={() =>
              id &&
              router.push(`/simulating?id=${encodeURIComponent(id)}&replay=1`)
            }
            disabled={!id}
          >
            View thread
          </Button>
          <Button
            variant="ghost"
            icon={<Icon name="refresh" size={13} />}
            onClick={() => router.push("/compose")}
          >
            Re-run
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={() => router.push("/compose")}>
            Edit draft
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function ReportBody({
  report,
  onUseRewrite,
}: {
  report: Report;
  onUseRewrite: (text: string) => void;
}) {
  return (
    <>
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
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
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
    </>
  );
}

export default function ReportPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <ReportInner />
      </Suspense>
    </RequireAuth>
  );
}
