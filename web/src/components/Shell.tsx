"use client";
import type { ReactNode, CSSProperties } from "react";
import { Avatar, Eyebrow } from "./ui/Primitives";
import { Sidebar, type SidebarKey } from "./Sidebar";

// ─────────────────────────────────────────────────────────────
// Frame — dark app shell wrapper used by every view.
// Sidebar + topbar + scrollable content area.
// ─────────────────────────────────────────────────────────────
export function Frame({
  children,
  sidebarActive = "compose",
  topbarLabel,
  topbarRight,
  contentPad = "32px 48px",
}: {
  children: ReactNode;
  sidebarActive?: SidebarKey;
  topbarLabel?: ReactNode;
  topbarRight?: ReactNode;
  contentPad?: CSSProperties["padding"];
}) {
  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <Sidebar active={sidebarActive} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <FrameTopBar label={topbarLabel} right={topbarRight} />
        <div style={{ flex: 1, padding: contentPad }}>{children}</div>
      </main>
    </div>
  );
}

function FrameTopBar({ label, right }: { label?: ReactNode; right?: ReactNode }) {
  return (
    <div
      style={{
        height: 56,
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        gap: 12,
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--fg-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {right}
      <div style={{ flex: 1 }} />
      <Avatar initials="ED" size={28} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PageHeader
// ─────────────────────────────────────────────────────────────
export function PageHeader({
  eyebrow,
  title,
  sub,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 6 }}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h1
        style={{
          margin: 0,
          fontSize: 30,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          color: "var(--fg-1)",
        }}
      >
        {title}
      </h1>
      {sub && (
        <p style={{ margin: 0, fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5, maxWidth: 620 }}>
          {sub}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// StepIndicator — compact dots-only step bar in top bar.
// ─────────────────────────────────────────────────────────────
export function StepIndicator({ step }: { step: number }) {
  const total = 4;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          style={{
            width: i === step ? 18 : 6,
            height: 6,
            borderRadius: 999,
            background: i <= step ? "var(--accent-200)" : "var(--surface-3)",
            transition: "width 200ms",
          }}
        />
      ))}
    </div>
  );
}
