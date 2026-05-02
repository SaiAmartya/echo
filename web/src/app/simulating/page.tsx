"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TopNav } from "@/components/Shell";
import { Button, Eyebrow, Icon, Badge } from "@/components/ui/Primitives";
import { SwarmThread } from "@/components/SwarmThread";

type StoredSim = { simulation_id: string; rounds: number; draft: string; audience: { name: string } };

export default function SimulatingPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") || "";
  const [sim, setSim] = useState<StoredSim | null>(null);
  const [round, setRound] = useState(1);
  const [agentsResponded, setAgentsResponded] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("echo:simulation");
    if (stored) {
      try { setSim(JSON.parse(stored)); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    const url = `/api/simulate/stream?simulation_id=${encodeURIComponent(id)}`;
    const es = new EventSource(url);
    es.addEventListener("round", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        if (typeof data.round === "number") setRound(data.round);
        if (typeof data.agents_responded === "number") setAgentsResponded(data.agents_responded);
      } catch { /* ignore */ }
    });
    es.addEventListener("done", () => {
      setDone(true);
      es.close();
      router.push(`/results?id=${encodeURIComponent(id)}`);
    });
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [id, router]);

  const totalRounds = sim?.rounds ?? 5;
  const progress = useMemo(() => Math.min(1, round / totalRounds), [round, totalRounds]);
  const sentimentValue = -0.08;

  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <TopNav active="compose" audience={sim?.audience?.name ?? "sample · audience"} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: "calc(100vh - 56px)" }}>
        <div style={{ width: 360, borderRight: "1px solid var(--border)", padding: 28, display: "flex", flexDirection: "column", gap: 18, overflow: "auto" }}>
          <Eyebrow>Draft · running</Eyebrow>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, fontSize: 14, color: "var(--fg-1)", lineHeight: 1.45 }}>
            {sim?.draft ?? "—"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Eyebrow>Live readout</Eyebrow>
            <ReadStat label="Agents responded" value={`${agentsResponded}`} sub="of 200" />
            <ReadStat label="Mean sentiment" value={`${sentimentValue >= 0 ? "+" : ""}${sentimentValue.toFixed(2)}`} sub="trending down" color="#f06c5a" />
            <ReadStat label="Round" value={`${round}`} sub={`of ${totalRounds}`} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <Eyebrow>Round {round} of {totalRounds}</Eyebrow>
            <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${progress * 100}%`, height: "100%", background: "var(--accent-200)", transition: "width 200ms linear" }} />
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
              {done ? "complete" : `~${Math.max(0, Math.round((1 - progress) * 60))}s remaining`}
            </span>
          </div>
          <Button variant="ghost" size="sm" icon={<Icon name="x" size={12} />} onClick={() => router.push("/compose")}>Cancel run</Button>
        </div>
        <div style={{ flex: 1, position: "relative", background: "var(--bg-deep)", overflow: "hidden", padding: 24 }}>
          <div style={{ position: "absolute", top: 40, left: 40, zIndex: 2 }}>
            <Badge tone="accent" dot pulse>{done ? "Complete" : "Live · 200 agents"}</Badge>
          </div>
          <div style={{ height: "100%", borderRadius: 16, overflow: "hidden" }}>
            <SwarmThread currentRound={round} seedDraft={sim?.draft ?? ""} running={!done} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: color || "var(--fg-1)" }}>{value}</span>
      {sub && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>{sub}</span>}
    </div>
  );
}
