"use client";
// 05 — History
// Ported from design/echo/project/lib/views.jsx (View05_History)

import { Frame, PageHeader } from "@/components/Shell";
import { Badge } from "@/components/ui/Primitives";

type Tone = "positive" | "caution" | "danger";

const items: Array<{
  draft: string;
  sentiment: number;
  replies: number;
  rounds: number;
  when: string;
  tone: Tone;
}> = [
  {
    draft:
      "Notion is replacing all-hands with a written weekly memo. Meetings are a tax on focus. We'd rather ship.",
    sentiment: 0.04,
    replies: 17,
    rounds: 5,
    when: "4 seconds ago",
    tone: "caution",
  },
  {
    draft: "we're done with quarterly OKRs. shipping monthly.",
    sentiment: 0.34,
    replies: 24,
    rounds: 5,
    when: "2 hours ago",
    tone: "caution",
  },
  {
    draft: "hot take: most design systems are just CSS reset packages with extra steps.",
    sentiment: -0.18,
    replies: 41,
    rounds: 8,
    when: "yesterday",
    tone: "danger",
  },
  {
    draft: "Echo just shipped: paste a draft, see the replies before you post.",
    sentiment: 0.62,
    replies: 19,
    rounds: 5,
    when: "3 days ago",
    tone: "positive",
  },
  {
    draft:
      "calling it now: the next decade of software is built around feedback loops, not features.",
    sentiment: 0.41,
    replies: 30,
    rounds: 8,
    when: "last week",
    tone: "positive",
  },
];

const filters = ["All · 14", "Low risk · 6", "Mild · 5", "High risk · 3"];

export default function HistoryPage() {
  return (
    <Frame topbarLabel="History" sidebarActive="history">
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader title="Past simulations" sub="Click any to see the analysis." />

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {filters.map((t, i) => (
            <span
              key={t}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 12,
                background: i === 0 ? "var(--surface-2)" : "transparent",
                color: i === 0 ? "var(--fg-1)" : "var(--fg-3)",
                border: i === 0 ? "1px solid var(--border-strong)" : "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              {t}
            </span>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((h, i) => (
            <div
              key={i}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 16,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.45 }}>{h.draft}</div>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--fg-3)",
                  flexWrap: "wrap",
                }}
              >
                <Badge tone={h.tone} dot>
                  {h.tone === "positive"
                    ? "Low risk"
                    : h.tone === "caution"
                      ? "Mild ratio risk"
                      : "High ratio risk"}
                </Badge>
                <span style={{ color: h.sentiment >= 0 ? "#7dd49a" : "#f06c5a" }}>
                  {h.sentiment >= 0 ? "+" : ""}
                  {h.sentiment.toFixed(2)}
                </span>
                <span>
                  {h.replies} replies · {h.rounds} rounds
                </span>
                <span style={{ marginLeft: "auto" }}>{h.when}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}
