"use client";
// 05 — History
// Wires GET /history (CONTRACTS.md v2 §8). Visual layout preserved from the
// original static port; only the data source changes.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Frame, PageHeader } from "@/components/Shell";
import { Badge, Button } from "@/components/ui/Primitives";
import { api, ApiError, type HistoryItem, type HistoryTone } from "@/lib/api";

// Static decorative filter strip — counts here are just for v2 polish, not
// real aggregates. Per Phase E2 spec we keep this static.
const filters = ["All · 14", "Low risk · 6", "Mild · 5", "High risk · 3"];

function toneToBadge(tone: HistoryTone): { label: string; tone: "positive" | "caution" | "danger" | "neutral" } {
  switch (tone) {
    case "positive":
      return { label: "Low risk", tone: "positive" };
    case "caution":
      return { label: "Mild ratio risk", tone: "caution" };
    case "danger":
      return { label: "High ratio risk", tone: "danger" };
    case "neutral":
    default:
      return { label: "No analysis", tone: "neutral" };
  }
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function HistoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getHistory({ limit: 50 });
        if (cancelled) return;
        setItems(res.items);
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ApiError
            ? `${e.message} (${e.code})`
            : e instanceof Error
              ? e.message
              : "Failed to load history.";
        setError(msg);
        setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isLoading = items === null;
  const isEmpty = !isLoading && items.length === 0;

  return (
    <Frame topbarLabel="History" sidebarActive="history">
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader title="Past simulations" sub="Click any to see the analysis." />

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

        {isLoading && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 18,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--fg-3)",
            }}
          >
            Loading history…
          </div>
        )}

        {isEmpty && !error && (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 14, color: "var(--fg-1)" }}>No simulations yet</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
              Once you run a draft through Echo, every simulation lands here.
            </div>
            <Button variant="ghost" size="sm" onClick={() => router.push("/compose")}>
              Run your first one
            </Button>
          </div>
        )}

        {!isLoading && !isEmpty && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((h) => {
              const badge = toneToBadge(h.tone);
              return (
                <div
                  key={h.simulation_id}
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/report?id=${encodeURIComponent(h.simulation_id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/report?id=${encodeURIComponent(h.simulation_id)}`);
                    }
                  }}
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
                    <Badge tone={badge.tone} dot>
                      {badge.label}
                    </Badge>
                    <span style={{ color: h.mean_sentiment >= 0 ? "#7dd49a" : "#f06c5a" }}>
                      {h.mean_sentiment >= 0 ? "+" : ""}
                      {h.mean_sentiment.toFixed(2)}
                    </span>
                    <span>
                      {h.post_count} replies · {h.rounds} rounds
                    </span>
                    <span style={{ marginLeft: "auto" }}>{relativeTime(h.created_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Frame>
  );
}
