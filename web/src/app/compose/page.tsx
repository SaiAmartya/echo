"use client";
// 02 — Compose (write the message + pick rounds)
// Ported from design/echo/project/lib/views.jsx (View02_Compose)

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Frame, PageHeader, StepIndicator } from "@/components/Shell";
import { Composer } from "@/components/Composer";
import { SEED_DRAFT } from "@/components/SwarmThread";
import { api, ApiError, type Audience } from "@/lib/api";

const ROUND_OPTIONS = [3, 4, 5, 6] as const;
const DEFAULT_ROUNDS = 5;

function loadAudience(): Audience | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem("echo:audience");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Audience;
  } catch {
    return null;
  }
}

function loadDraft(): string {
  if (typeof window === "undefined") return SEED_DRAFT;
  return window.sessionStorage.getItem("echo:draft") ?? SEED_DRAFT;
}

export default function ComposePage() {
  const router = useRouter();
  const [draft, setDraft] = useState(SEED_DRAFT);
  const [rounds, setRounds] = useState<number>(DEFAULT_ROUNDS);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAudience(loadAudience());
    setDraft(loadDraft());
  }, []);

  // Keep the draft in sessionStorage as the user types so /results can return.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("echo:draft", draft);
  }, [draft]);

  const audienceLabel = audience
    ? `${audience.name} · ${audience.size.toLocaleString()} agents`
    : "No audience yet — go back to seed";

  const onRun = async () => {
    if (submitting) return;
    if (!audience) {
      setError("No audience loaded — go back to the seed step.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await api.simulateStart({
        draft,
        audience_id: audience.audience_id,
        rounds,
      });
      sessionStorage.setItem("echo:simulation", JSON.stringify(resp));
      router.push(`/simulating?id=${encodeURIComponent(resp.simulation_id)}`);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? `${e.message} (${e.code})`
          : e instanceof Error
            ? e.message
            : "Failed to start simulation.";
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <Frame topbarLabel="Compose" sidebarActive="compose" topbarRight={<StepIndicator step={1} />}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader title="What are you posting?" sub="200 agents react, then react to each other." />

        <Composer
          draft={draft}
          setDraft={setDraft}
          audience={audienceLabel}
          onRun={onRun}
          disabled={submitting || !audience}
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
      </div>
    </Frame>
  );
}
