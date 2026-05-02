"use client";
// Full report page (CONTRACTS v3 §12, §13).
// S1 (2026-05-02): the editorial body has been extracted to
// `web/src/components/ReportBody.tsx` so /simulating can render it inline in
// the right column. This page is now the standalone fullscreen deep-link view
// — chrome (Frame, topbar, footer CTAs) lives here; body lives in ReportBody.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame } from "@/components/Shell";
import { Badge, Button, Icon } from "@/components/ui/Primitives";
import { ReportBody } from "@/components/ReportBody";
import { api, ApiError, type ReportResponse } from "@/lib/api";
import { RequireAuth } from "@/components/auth/RequireAuth";

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
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Badge tone="neutral">
                {report.mode === "hypothetical" ? "Hypothetical" : "Business"}
              </Badge>
            </div>
            <ReportBody
              report={report.report}
              onUseRewrite={(text) => {
                if (typeof window !== "undefined") {
                  window.sessionStorage.setItem("echo:draft", text);
                }
                router.push("/compose");
              }}
            />
          </>
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

export default function ReportPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <ReportInner />
      </Suspense>
    </RequireAuth>
  );
}
