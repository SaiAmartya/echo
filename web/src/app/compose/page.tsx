"use client";
// 02 — Compose (write the message + pick rounds)
// Ported from design/echo/project/lib/views.jsx (View02_Compose)

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Frame, PageHeader, StepIndicator } from "@/components/Shell";
import { Composer } from "@/components/Composer";
import { SEED_DRAFT } from "@/components/SwarmThread";
import { Icon } from "@/components/ui/Primitives";
import { api, ApiError, type Audience, type SimulationMode } from "@/lib/api";

const ROUND_OPTIONS = [3, 4, 5, 6] as const;
const DEFAULT_ROUNDS = 5;

type Mode = SimulationMode;
const MODE_STORAGE_KEY = "echo:mode";

function isMode(v: string | null): v is Mode {
  return v === "hypothetical" || v === "business";
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "hypothetical";
  const raw = window.sessionStorage.getItem(MODE_STORAGE_KEY);
  return isMode(raw) ? raw : "hypothetical";
}

const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: "hypothetical", label: "Hypothetical situation" },
  { value: "business", label: "Business post · Notion · 200 agents" },
];

const MODE_HERO: Record<Mode, { title: string; sub: string }> = {
  hypothetical: {
    title: "What will people think if...",
    sub: "200 agents react, then react to each other.",
  },
  business: {
    title: "What are you posting?",
    sub: "200 agents react, then react to each other.",
  },
};

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
  const [mode, setMode] = useState<Mode>("hypothetical");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from sessionStorage on mount. P1's safety-net auto-seed is gone:
  // hypothetical mode (the new default) doesn't need an audience at all, and
  // business mode now seeds inside onRun if needed.
  useEffect(() => {
    setAudience(loadAudience());
    setDraft(loadDraft());
    setMode(loadMode());
  }, []);

  // Keep the draft in sessionStorage as the user types so /report can return.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("echo:draft", draft);
  }, [draft]);

  // Persist selected mode so /simulating (and a refresh of /compose) can read it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  const onRun = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let resp;
      if (mode === "hypothetical") {
        // Hypothetical: backend routes against the built-in general public
        // audience. Omit audience_id entirely — cleaner wire (per v4 §16).
        resp = await api.simulateStart({
          draft,
          mode: "hypothetical",
          rounds,
        });
      } else {
        // Business: ensure we have an audience cached. If not, seed the sample
        // audience inline (the Audience sidebar tab is gone in v4).
        let aud = audience;
        if (!aud) {
          aud = await api.seed({ mode: "sample", payload: null });
          window.sessionStorage.setItem("echo:audience", JSON.stringify(aud));
          setAudience(aud);
        }
        resp = await api.simulateStart({
          draft,
          mode: "business",
          audience_id: aud.audience_id,
          rounds,
        });
      }
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

  const hero = MODE_HERO[mode];

  const modeDropdown = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        color: "var(--fg-2)",
        position: "relative",
      }}
    >
      <Icon name="users" size={13} />
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--fg-2)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          paddingRight: 18,
          cursor: "pointer",
        }}
      >
        {MODE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        style={{ opacity: 0.6, position: "absolute", right: 10, pointerEvents: "none" }}
      />
    </span>
  );

  return (
    <Frame topbarLabel="Compose" sidebarActive="compose" topbarRight={<StepIndicator step={1} />}>
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <PageHeader title={hero.title} sub={hero.sub} />

        <Composer
          draft={draft}
          setDraft={setDraft}
          audience=""
          audienceSlot={modeDropdown}
          onRun={onRun}
          disabled={submitting}
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
