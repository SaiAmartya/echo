"use client";
import { TopNav } from "@/components/Shell";
import { Badge, Eyebrow, Icon } from "@/components/ui/Primitives";
import { HISTORY } from "@/lib/data";

export default function HistoryPage() {
  const colors: Record<string, string> = { positive: "#7dd49a", caution: "#e8b75a", danger: "#f06c5a" };
  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <TopNav active="history" audience="Notion · core" />
      <div style={{ flex: 1, overflow: "auto", padding: "28px 32px" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <Eyebrow>History</Eyebrow>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>47 runs · last 30 days</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>Filter:</span>
            <Badge tone="accent">Notion · core</Badge>
            <Badge tone="mono">All time</Badge>
          </div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: "-0.02em" }}>Past simulations.</h1>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {HISTORY.map((h, i) => (
              <div key={i} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, display: "flex", gap: 14, alignItems: "center", cursor: "pointer" }}>
                <div style={{ width: 4, alignSelf: "stretch", background: colors[h.tone], borderRadius: 2 }} />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.45 }}>{h.draft}</span>
                  <div style={{ display: "flex", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
                    <span>{h.audience}</span><span>·</span><span>{h.replies} replies</span>
                    {h.flags > 0 && <><span>·</span><span style={{ color: "#e8b75a" }}>{h.flags} flag{h.flags === 1 ? "" : "s"}</span></>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, minWidth: 110 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: colors[h.tone] }}>{h.sentiment >= 0 ? "+" : ""}{h.sentiment.toFixed(2)}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{h.when}</span>
                </div>
                <Icon name="arrowUpRight" size={14} style={{ color: "var(--fg-3)" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
