"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TopNav, PostPreview } from "@/components/Shell";
import { Button, EchoMark, Eyebrow, Icon } from "@/components/ui/Primitives";
import { api } from "@/lib/api";
import { SAMPLE_DRAFT } from "@/lib/data";

type StoredAudience = { audience_id: string; name: string; size: number };

export default function ComposePage() {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState("");
  const [rounds, setRounds] = useState(5);
  const [audience, setAudience] = useState<StoredAudience | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("echo:audience");
    if (stored) {
      try { setAudience(JSON.parse(stored)); } catch { /* ignore */ }
    }
    if (params.get("sample")) setDraft(SAMPLE_DRAFT);
  }, [params]);

  async function run() {
    if (!draft.trim()) { setError("Add a draft first."); return; }
    setBusy(true); setError(null);
    try {
      let aud = audience;
      if (!aud) {
        aud = await api.seed({ mode: "sample" });
        sessionStorage.setItem("echo:audience", JSON.stringify(aud));
        setAudience(aud);
      }
      const res = await api.simulateStart({ draft, audience_id: aud.audience_id, rounds });
      sessionStorage.setItem("echo:simulation", JSON.stringify({ ...res, draft, audience: aud }));
      router.push(`/simulating?id=${encodeURIComponent(res.simulation_id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <TopNav active="compose" audience={audience?.name ?? "sample · audience"} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)", overflow: "auto" }}>
          <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Eyebrow>Draft</Eyebrow>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>What are you about to post?</h2>
            </div>
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Paste your draft here…"
                style={{
                  background: "transparent", border: "none", outline: "none", resize: "vertical",
                  fontSize: 16, color: "var(--fg-1)", lineHeight: 1.45, minHeight: 80,
                  fontFamily: "var(--font-sans)",
                }}
              />
              <PostPreview text={draft} />
              <div style={{ display: "flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <span>plain text · no media</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: draft.length > 280 ? "#f06c5a" : "var(--fg-3)" }}>{draft.length} / 280</span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 999, fontSize: 12, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg-2)" }}>
                <Icon name="users" size={12} />
                <span style={{ fontFamily: "var(--font-mono)" }}>{audience?.name ?? "sample · audience"}</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-4)" }}>· {audience?.size?.toLocaleString() ?? "8,420"}</span>
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>~60s · 200 agents</span>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
                rounds
                <input type="number" value={rounds} min={3} max={20} onChange={(e) => setRounds(Math.min(20, Math.max(3, Number(e.target.value) || 5)))}
                  style={{ width: 48, background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px", color: "var(--fg-1)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
              </label>
              <div style={{ flex: 1 }} />
              <Button variant="primary" disabled={busy} icon={<Icon name="play" size={12} />} onClick={run}>{busy ? "Starting…" : "Run simulation"}</Button>
            </div>
            {error && <span style={{ fontSize: 12, color: "#f06c5a" }}>{error}</span>}
          </div>
        </div>

        <div style={{ width: 420, background: "var(--bg-deep)", display: "flex", flexDirection: "column", padding: 28, gap: 16 }}>
          <Eyebrow>Simulation</Eyebrow>
          <div style={{ flex: 1, border: "1px dashed var(--border-strong)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14, padding: 24, textAlign: "center" }}>
            <EchoMark size={40} accent={false} />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "var(--fg-1)" }}>Paste a draft to begin.</h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--fg-3)", maxWidth: 280 }}>
              Once you hit run, this panel turns into a live network of 200 agents reacting in real time.
            </p>
            <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--fg-4)", marginTop: 10 }}>
              the wait is part of the experience
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
