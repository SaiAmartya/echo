"use client";
// 04 — Analysis (aggregated takeaway)
// Ported from design/echo/project/lib/views.jsx (View04_Analysis)

import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Eyebrow, Icon } from "@/components/ui/Primitives";

export default function ResultsPage() {
  return (
    <Frame topbarLabel="Analysis" sidebarActive="compose" topbarRight={<StepIndicator step={3} />}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
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
            The idea lands.{" "}
            <span style={{ fontStyle: "normal", fontFamily: "var(--font-sans)" }}>The phrasing</span> doesn't.
          </p>
          <p style={{ margin: 0, fontSize: 14, color: "var(--fg-2)", lineHeight: 1.55 }}>
            Skeptics aren't pushing back on the substance — they're pushing back on "meetings are a tax on focus" reading
            as absolutist. By round 4, consensus formed: change the phrasing, keep the substance.
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
                Notion is replacing all-hands with a written weekly memo.{" "}
                <s style={{ color: "var(--fg-3)" }}>Meetings are a tax on focus.</s> We'd rather ship.
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
                Trying something at Notion: replacing the weekly all-hands with a written memo. We want to give the team
                back focus time and let writing do the alignment work.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" size="sm">
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
          {[
            {
              color: "#f06c5a",
              label: "Skeptic dogpile",
              tldr: '"Monthly is just shorter quarters" — challenges the cadence framing, not the writing.',
            },
            {
              color: "#9bc97f",
              label: "Practitioner save",
              tldr: "Sales-context counter-example — they tried it, what stayed live, what became a memo.",
            },
            {
              color: "#7dd49a",
              label: "Consensus emerging",
              tldr: '"Change the phrasing, keep the substance."',
            },
          ].map((c, i) => (
            <div
              key={c.label}
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
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
          <Button variant="ghost" icon={<Icon name="refresh" size={13} />}>
            Re-run
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary">Edit draft</Button>
          <Button variant="primary">Publish</Button>
        </div>
      </div>
    </Frame>
  );
}
