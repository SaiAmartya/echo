"use client";
// 04 — Analysis (aggregated takeaway)
// Ported from design/echo/project/lib/views.jsx (View04_Analysis)

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Eyebrow, Icon } from "@/components/ui/Primitives";
import { api, ApiError, type Analysis } from "@/lib/api";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 10;

function ResultsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("Missing simulation id.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;

    const tick = async () => {
      attempts += 1;
      try {
        const result = await api.analyze(id);
        if (cancelled) return;
        setAnalysis(result);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 409 && e.code === "analysis_pending") {
          if (attempts >= MAX_POLL_ATTEMPTS) {
            setError("Analysis is still computing. Please retry shortly.");
            setLoading(false);
            return;
          }
          window.setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        const msg =
          e instanceof ApiError
            ? `${e.message} (${e.code})`
            : e instanceof Error
              ? e.message
              : "Failed to load analysis.";
        setError(msg);
        setLoading(false);
      }
    };

    void tick();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const onUseRewrite = () => {
    if (!analysis) return;
    sessionStorage.setItem("echo:draft", analysis.suggested_rewrite.rewrite);
    router.push("/compose");
  };

  return (
    <Frame topbarLabel="Analysis" sidebarActive="compose" topbarRight={<StepIndicator step={3} />}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
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
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            Still computing the analysis…
          </div>
        )}

        {/* Headline takeaway */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderLeft: "2px solid var(--accent-200)",
            borderRadius: 12,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <p
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: 28,
              lineHeight: 1.3,
              color: "var(--fg-1)",
              letterSpacing: "-0.01em",
            }}
          >
            {analysis?.tldr ?? "—"}
          </p>
        </div>

        {/* Suggested rewrite */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="sparkles" size={14} style={{ color: "var(--accent-200)" }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)" }}>Suggested rewrite</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div
              style={{
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <Eyebrow>Original</Eyebrow>
              <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.5, marginTop: 8 }}>
                {analysis?.suggested_rewrite.original ?? "—"}
              </div>
            </div>
            <div
              style={{
                background: "rgba(212,255,92,0.06)",
                border: "1px solid rgba(212,255,92,0.25)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <Eyebrow>Rewrite</Eyebrow>
              <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.5, marginTop: 8 }}>
                {analysis?.suggested_rewrite.rewrite ?? "—"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" size="sm" onClick={onUseRewrite} disabled={!analysis}>
              Use rewrite
            </Button>
            <Button variant="ghost" size="sm">
              Show 2 more
            </Button>
          </div>
        </div>

        {/* Reply chains worth reading */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)", marginBottom: 6 }}>Worth reading</div>
          {(analysis?.worth_reading ?? []).map((c, i) => (
            <div
              key={`${c.label}-${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--fg-2)", minWidth: 130, flexShrink: 0 }}>{c.label}</span>
              <span style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.45, flex: 1 }}>{c.tldr}</span>
              <Icon name="arrowUpRight" size={12} style={{ color: "var(--fg-3)" }} />
            </div>
          ))}
          {!analysis && !loading && !error && (
            <div style={{ fontSize: 12, color: "var(--fg-3)", padding: "10px 0" }}>No reply chains yet.</div>
          )}
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
          <Button variant="ghost" icon={<Icon name="refresh" size={13} />} onClick={() => router.push("/compose")}>
            Re-run
          </Button>
          <Button
            variant="ghost"
            icon={<Icon name="replies" size={13} />}
            onClick={() =>
              id && router.push(`/simulating?id=${encodeURIComponent(id)}&replay=1`)
            }
            disabled={!id}
          >
            View thread again
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" onClick={() => router.push("/compose")}>
            Edit draft
          </Button>
          <Button variant="primary">Publish</Button>
        </div>
      </div>
    </Frame>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <ResultsInner />
    </Suspense>
  );
}
