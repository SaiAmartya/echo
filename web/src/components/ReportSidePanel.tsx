"use client";
// ReportSidePanel — phase-driven right-column override for /simulating.
//
// S1 (2026-05-02): owns the post-streaming transitions in the right column —
// `report-pending` spinner, `report-failed` retry, and `ready` (ReportBody
// + subtle fullscreen icon top-right). Extracted from /simulating/page.tsx
// to keep that file under 500 lines.
//
// L13 applied: the killer-flow (inline report) is the default; the escape
// hatch (fullscreen) is opt-in. The fullscreen affordance is icon-only,
// muted, hover-lifts; not a labeled button.

import { Button, Icon } from "@/components/ui/Primitives";
import { ReportBody } from "@/components/ReportBody";
import type { ReportResponse } from "@/lib/api";

export type SidePanelPhase =
  | "report-pending"
  | "report-failed"
  | "ready";

export function ReportSidePanel({
  phase,
  report,
  onRetry,
  onFullscreen,
  canRetry,
}: {
  phase: SidePanelPhase;
  report: ReportResponse | null;
  onRetry: () => void;
  onFullscreen: () => void;
  canRetry: boolean;
}) {
  if (phase === "ready" && report) {
    return (
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <FullscreenIconButton onClick={onFullscreen} />
        <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
          <ReportBody report={report.report} />
        </div>
      </div>
    );
  }

  // report-pending / report-failed → centered status panel filling the column.
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 200,
      }}
    >
      {phase === "report-pending" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              border: "2px solid var(--border-strong)",
              borderTopColor: "var(--fg-1)",
              animationName: "echo-spin",
              animationDuration: "0.8s",
              animationIterationCount: "infinite",
              animationTimingFunction: "linear",
            }}
          />
          <span style={{ color: "var(--fg-2)", fontSize: 13 }}>
            Analysis report generating…
          </span>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ color: "#f06c5a", fontSize: 13 }}>
            Report generation failed.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={!canRetry}
          >
            Retry report generation
          </Button>
        </div>
      )}
    </div>
  );
}

// Subtle fullscreen icon, top-right of the report panel. ~16px stroke icon,
// var(--fg-3) muted, transparent background, no border. Hover lifts to
// var(--fg-1) with a soft surface-2 wash. Native button so keyboard nav
// works; title attribute and aria-label both set per a11y.
function FullscreenIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open in fullscreen"
      aria-label="Open in fullscreen"
      style={{
        position: "absolute",
        top: 10,
        right: 10,
        width: 28,
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        color: "var(--fg-3)",
        cursor: "pointer",
        padding: 0,
        zIndex: 2,
        transition: "color 120ms var(--ease-out), background 120ms",
      }}
      onMouseEnter={(e) => {
        const t = e.currentTarget;
        t.style.color = "var(--fg-1)";
        t.style.background = "var(--surface-2)";
      }}
      onMouseLeave={(e) => {
        const t = e.currentTarget;
        t.style.color = "var(--fg-3)";
        t.style.background = "transparent";
      }}
    >
      <Icon name="expand" size={16} />
    </button>
  );
}
