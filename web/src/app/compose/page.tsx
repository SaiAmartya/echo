"use client";
// 02 — Compose (write the message + pick rounds)
// Ported from design/echo/project/lib/views.jsx (View02_Compose)

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Frame, PageHeader, StepIndicator } from "@/components/Shell";
import { Composer } from "@/components/Composer";
import { SEED_DRAFT } from "@/components/SwarmThread";

const ROUND_OPTIONS = [3, 5, 8, 12, 20];

export default function ComposePage() {
  const router = useRouter();
  const [draft, setDraft] = useState(SEED_DRAFT);
  const [rounds, setRounds] = useState(5);

  return (
    <Frame topbarLabel="Compose" sidebarActive="compose" topbarRight={<StepIndicator step={1} />}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader title="What are you posting?" sub="200 agents react, then react to each other." />

        <Composer
          draft={draft}
          setDraft={setDraft}
          audience={"Notion · 200 agents"}
          onRun={() => router.push("/simulating")}
        />

        {/* Rounds picker — compact slider-style */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 13, color: "var(--fg-1)" }}>Rounds</div>
          <div style={{ flex: 1, display: "flex", gap: 6 }}>
            {ROUND_OPTIONS.map((n) => {
              const active = rounds === n;
              return (
                <span
                  key={n}
                  onClick={() => setRounds(n)}
                  style={{
                    flex: 1,
                    textAlign: "center",
                    padding: "8px 0",
                    borderRadius: 6,
                    fontSize: 13,
                    background: active ? "var(--surface-2)" : "transparent",
                    border: "1px solid " + (active ? "var(--border-strong)" : "var(--border)"),
                    color: active ? "var(--fg-1)" : "var(--fg-2)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {n}
                </span>
              );
            })}
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>~90s</span>
        </div>
      </div>
    </Frame>
  );
}
