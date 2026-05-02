"use client";
// 01 — Seed (set up persona pool)
// Ported from design/echo/project/lib/views.jsx (View01_Seed)

import Link from "next/link";
import type { ReactNode } from "react";
import { Frame, PageHeader, StepIndicator } from "@/components/Shell";
import { Badge, Button, Eyebrow, Icon } from "@/components/ui/Primitives";

export default function SeedPage() {
  return (
    <Frame topbarLabel="Seed" sidebarActive="audience" topbarRight={<StepIndicator step={0} />}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader
          title="Who's in the room?"
          sub="Drop in source material. Echo synthesizes 200 personas."
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <SeedSource
            icon="document"
            title="PDF / docs"
            detail="audience-research.pdf · 24 pages"
            status="active"
            metric="parsed 187 personas"
          />
          <SeedSource
            icon="x"
            title="Connect X"
            detail="@notion · 2.4M followers"
            status="connected"
            metric="sampled 200 / 2.4M"
          />
          <SeedSource
            icon="brief"
            title="Quick brief"
            detail="Describe the audience in 1–3 sentences"
            status="idle"
          />
        </div>

        {/* Pool preview */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Eyebrow>Synthesized persona pool · 200 agents</Eyebrow>
              <div style={{ fontSize: 14, color: "var(--fg-1)" }}>
                Notion's product audience · founders, eng leaders, ops folks.
              </div>
            </div>
            <Button variant="ghost" size="sm">
              Resample
            </Button>
          </div>

          {/* Mini agent grid — rows of dots colored by archetype */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(40, 1fr)",
              gap: 4,
              padding: "10px 0",
            }}
          >
            {Array.from({ length: 200 }).map((_, i) => {
              const colors = ["#7dd49a", "#7dd49a", "#9bc97f", "#b8b8c0", "#b8b8c0", "#e8b75a", "#f06c5a"];
              const c = colors[i % colors.length];
              return (
                <span
                  key={i}
                  style={{ width: 8, height: 8, borderRadius: 2, background: c, opacity: 0.85 }}
                />
              );
            })}
          </div>

          {/* Composition row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
            {[
              { c: "#7dd49a", label: "Enthusiast",   pct: 28 },
              { c: "#9bc97f", label: "Practitioner", pct: 18 },
              { c: "#b8b8c0", label: "Curious",      pct: 24 },
              { c: "#b8b8c0", label: "Lurker",       pct: 12 },
              { c: "#e8b75a", label: "Pedant",       pct: 10 },
              { c: "#f06c5a", label: "Skeptic",      pct: 8  },
            ].map((s) => (
              <div key={s.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: s.c }} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-1)" }}>
                    {s.pct}%
                  </span>
                </div>
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <Button variant="ghost">Save as preset</Button>
          <Link href="/compose" style={{ textDecoration: "none" }}>
            <Button variant="primary" icon={<Icon name="arrowUpRight" size={12} />}>
              Use this audience
            </Button>
          </Link>
        </div>
      </div>
    </Frame>
  );
}

type SourceIcon = "document" | "x" | "brief";

function SeedSource({
  icon,
  title,
  detail,
  status,
  metric,
}: {
  icon: SourceIcon;
  title: string;
  detail: string;
  status: "active" | "connected" | "idle";
  metric?: string;
}) {
  const isActive = status === "active";
  const isConnected = status === "connected";
  const ring = isActive ? "1px solid var(--accent-300)" : "1px solid var(--border)";
  const iconNode: Record<SourceIcon, ReactNode> = {
    document: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </svg>
    ),
    x: <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>𝕏</span>,
    brief: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 5h18M3 12h18M3 19h12" />
      </svg>
    ),
  };

  return (
    <div
      style={{
        background: "var(--surface)",
        border: ring,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
      }}
    >
      {isActive && (
        <span
          style={{
            position: "absolute",
            top: -10,
            right: 12,
            background: "var(--accent-200)",
            color: "#0a0c00",
            padding: "2px 8px",
            borderRadius: 999,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Active
        </span>
      )}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fg-1)",
        }}
      >
        {iconNode[icon]}
      </div>
      <div>
        <div style={{ fontSize: 14, color: "var(--fg-1)" }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>{detail}</div>
      </div>
      {metric && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-2)",
            marginTop: "auto",
          }}
        >
          {metric}
        </div>
      )}
      {status === "idle" && (
        <Button variant="secondary" size="sm" style={{ alignSelf: "flex-start" }}>
          Add
        </Button>
      )}
      {isConnected && (
        <Badge tone="positive" dot>
          Connected
        </Badge>
      )}
    </div>
  );
}
