"use client";
// 03 — Rounds (live swarm thread)
// Ported from design/echo/project/lib/views.jsx (View03_Rounds + LiveRounds)

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Icon } from "@/components/ui/Primitives";
import { SEED_DRAFT, SwarmThread } from "@/components/SwarmThread";

const MAX_ROUNDS = 5;

export default function SimulatingPage() {
  const router = useRouter();
  const [round, setRound] = useState(1);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setRound((r) => {
        if (r >= MAX_ROUNDS) {
          setRunning(false);
          return r;
        }
        return r + 1;
      });
    }, 2400);
    return () => clearInterval(id);
  }, [running]);

  return (
    <Frame
      topbarLabel={running ? `Round ${round} of ${MAX_ROUNDS}` : "Simulation complete"}
      sidebarActive="compose"
      topbarRight={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {running && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "var(--accent-200)",
                animationName: "echo-pulse",
                animationDuration: "1.4s",
                animationIterationCount: "infinite",
              }}
            />
          )}
          <StepIndicator step={2} />
        </div>
      }
      contentPad="20px 24px"
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          height: "calc(100vh - 56px - 40px)",
        }}
      >
        <div style={{ flex: 1, minHeight: 0 }}>
          <SwarmThread currentRound={round} maxRounds={MAX_ROUNDS} seedDraft={SEED_DRAFT} running={running} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {running ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="pause" size={11} />}
              onClick={() => setRunning(false)}
            >
              Pause
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => router.push("/results")}>
              See analysis
            </Button>
          )}
        </div>
      </div>
    </Frame>
  );
}
