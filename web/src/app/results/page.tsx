"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TopNav, RatioRiskBig } from "@/components/Shell";
import { Avatar, Badge, Button, Eyebrow, Icon } from "@/components/ui/Primitives";
import { api, type AnalyzeResponse } from "@/lib/api";

export default function ResultsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") || "";
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("echo:simulation");
    if (stored) {
      try { setDraft(JSON.parse(stored).draft ?? ""); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    api.analyze(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <TopNav active="compose" audience="sample · audience" />
      <div style={{ flex: 1, overflow: "auto", padding: "28px 32px" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <Eyebrow>Result · just now</Eyebrow>
            {data && <Badge tone={data.tone === "positive" ? "positive" : data.tone === "danger" ? "danger" : "caution"} dot>
              {data.tone === "positive" ? "Low risk" : data.tone === "danger" ? "High ratio risk" : "Elevated ratio risk"}
            </Badge>}
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" icon={<Icon name="bookmark" size={11} />}>Save run</Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/compose")}>Edit draft</Button>
          </div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, fontSize: 16, color: "var(--fg-1)", lineHeight: 1.45 }}>
            {draft || "—"}
          </div>

          {error && <span style={{ fontSize: 12, color: "#f06c5a" }}>{error}</span>}
          {!data && !error && <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Aggregating…</span>}

          {data && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, alignItems: "start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <RatioRiskBig score={data.ratio_risk} tone={data.tone === "neutral" ? "caution" : data.tone} />
                <SentimentDistribution counts={{ pos: data.sentiment.pos, mix: data.sentiment.mix, neg: data.sentiment.neg }} />
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Predicted top replies</h3>
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{data.replies.length} of 247 · by likelihood</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {data.replies.map((r, i) => <ReplyCard key={i} reply={r} />)}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 0 }}>
                <RewriteCard rewrite={data.rewrite} />
                <div style={{ background: "var(--surface)", border: "1px solid rgba(232,183,90,0.2)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name="alert" size={14} style={{ color: "#e8b75a" }} />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>Risk flags</span>
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{data.flags.length} detected</span>
                  </div>
                  {data.flags.map((f, i) => (
                    <div key={i} style={{ background: "rgba(232,183,90,0.06)", borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.45, display: "flex", gap: 8 }}>
                      <span style={{ fontFamily: "var(--font-mono)", color: "#e8b75a" }}>{String(i + 1).padStart(2, "0")}</span>
                      <div>
                        <div style={{ color: "var(--fg-1)" }}>{f.title}</div>
                        <div style={{ color: "var(--fg-3)", marginTop: 2 }}>{f.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplyCard({ reply }: { reply: AnalyzeResponse["replies"][number] }) {
  const tone = reply.sentiment > 0.15 ? "#7dd49a" : reply.sentiment < -0.15 ? "#f06c5a" : "var(--fg-3)";
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, display: "flex", gap: 12 }}>
      <Avatar initials={reply.initials} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)" }}>{reply.name}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>{reply.handle}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-4)", marginLeft: "auto", textTransform: "uppercase", letterSpacing: "0.06em" }}>simulated</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{reply.text}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
          <span style={{ color: tone }}>{reply.sentiment >= 0 ? "+" : ""}{reply.sentiment.toFixed(2)}</span>
          <span>likely {reply.likely}%</span>
          <span>· {reply.archetype}</span>
        </div>
      </div>
    </div>
  );
}

function SentimentDistribution({ counts }: { counts: { pos: number; mix: number; neg: number } }) {
  const total = counts.pos + counts.mix + counts.neg || 1;
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <Eyebrow>Sentiment distribution</Eyebrow>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{total} replies</span>
      </div>
      <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div style={{ width: `${(counts.pos / total) * 100}%`, background: "#7dd49a" }} />
        <div style={{ width: `${(counts.mix / total) * 100}%`, background: "#43434b" }} />
        <div style={{ width: `${(counts.neg / total) * 100}%`, background: "#f06c5a" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
        <span><span style={{ color: "#7dd49a" }}>●</span> positive · {counts.pos}</span>
        <span><span style={{ color: "#b8b8c0" }}>●</span> mixed · {counts.mix}</span>
        <span><span style={{ color: "#f06c5a" }}>●</span> negative · {counts.neg}</span>
      </div>
    </div>
  );
}

function RewriteCard({ rewrite }: { rewrite: string }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid rgba(212,255,92,0.25)", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, right: 0, width: 200, height: 80, background: "radial-gradient(circle at top right, rgba(212,255,92,0.10), transparent 70%)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
        <span style={{ width: 24, height: 24, borderRadius: 6, background: "rgba(212,255,92,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-200)" }}>
          <Icon name="zap" size={13} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Critic agent suggests</span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, padding: 14, background: "var(--bg-deep)", borderRadius: 8, border: "1px solid var(--border)" }}>
        {rewrite}
      </div>
      <div style={{ display: "flex", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <Button variant="primary" size="sm" icon={<Icon name="refresh" size={11} />}>Re-run with this</Button>
        <Button variant="ghost" size="sm">Copy</Button>
      </div>
    </div>
  );
}
