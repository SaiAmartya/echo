"use client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { Button, EchoMark, Icon } from "@/components/ui/Primitives";
import { api } from "@/lib/api";

export default function AudiencePage() {
  const router = useRouter();
  const [tab, setTab] = useState<"csv" | "oauth">("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csv, setCsv] = useState("handle,text,timestamp\n@audrey_lin,\"interesting take, but...\",2026-04-02\n@mreid,\"finally someone said it.\",2026-04-02");

  async function build(mode: "csv" | "oauth" | "sample") {
    setBusy(true); setError(null);
    try {
      const res = await api.seed({ mode, payload: mode === "csv" ? csv : undefined });
      sessionStorage.setItem("echo:audience", JSON.stringify(res));
      router.push("/compose");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ height: 56, padding: "0 32px", display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: "inherit" }}>
          <EchoMark size={20} />
          <span style={{ fontWeight: 500, fontSize: 15 }}>echo</span>
        </Link>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => build("sample")}>Skip · use sample audience</Button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "48px 32px", display: "flex", justifyContent: "center" }}>
        <div style={{ width: 640, display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Step 1 of 1</span>
            <div style={{ flex: 1, height: 2, background: "var(--surface-2)", borderRadius: 1 }}>
              <div style={{ width: "100%", height: "100%", background: "var(--accent-200)", borderRadius: 1 }} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.15 }}>Seed your audience.</h1>
            <p style={{ margin: 0, fontSize: 15, color: "var(--fg-2)", maxWidth: 540 }}>
              We turn your real commenters into 200 simulated agents. Pick a path. Both take less than a minute.
            </p>
          </div>
          <div style={{ display: "flex", gap: 4, padding: 4, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, width: "fit-content" }}>
            {([{ id: "csv", label: "Paste audience data" }, { id: "oauth", label: "Connect X account" }] as const).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "8px 14px", border: "none", borderRadius: 6, fontSize: 13, cursor: "pointer",
                fontFamily: "var(--font-sans)",
                background: tab === t.id ? "var(--surface-2)" : "transparent",
                color: tab === t.id ? "var(--fg-1)" : "var(--fg-2)",
              }}>{t.label}</button>
            ))}
          </div>

          {tab === "csv" ? (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)" }}>Paste a CSV of past replies</span>
                <span style={{ fontSize: 12, color: "var(--fg-3)" }}>One reply per row. Handle, text, timestamp. We&apos;ll handle the rest.</span>
              </div>
              <textarea
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                style={{
                  background: "var(--bg-deep)", border: "1px dashed var(--border-strong)", borderRadius: 8,
                  padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-1)",
                  minHeight: 140, lineHeight: 1.6, resize: "vertical", outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 10 }}>
                <Button variant="ghost" size="sm">See example data</Button>
                <div style={{ flex: 1 }} />
                <Button variant="primary" disabled={busy} onClick={() => build("csv")}>{busy ? "Building…" : "Build audience"}</Button>
              </div>
            </div>
          ) : (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)" }}>Connect X (Twitter)</span>
                <span style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 480 }}>We pull your last 90 days of replies and mentions. Read-only. Tokens are encrypted at rest. You can disconnect anytime.</span>
              </div>
              <Button variant="primary" icon={<Icon name="arrowUpRight" size={12} />} disabled={busy} onClick={() => build("oauth")}>{busy ? "Connecting…" : "Connect with X"}</Button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)" }}>If the X API hiccups, we fall back to CSV automatically.</span>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <Icon name="users" size={14} style={{ color: "var(--fg-3)" }} />
            <span style={{ fontSize: 13, color: "var(--fg-2)" }}>No data? Try Echo with a sample Notion-style audience.</span>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" icon={<Icon name="play" size={11} />} disabled={busy} onClick={() => build("sample")}>Use this audience</Button>
          </div>

          {error && <span style={{ fontSize: 12, color: "#f06c5a" }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}
