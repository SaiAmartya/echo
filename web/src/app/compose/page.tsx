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

// v5 §20 — rounds range expanded to [5, 15]. Backend now 422s on rounds<5.
const ROUND_OPTIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const DEFAULT_ROUNDS = 5;

type Mode = SimulationMode;
const MODE_STORAGE_KEY = "echo:mode";
const ROUNDS_STORAGE_KEY = "echo:rounds";

function isMode(v: string | null): v is Mode {
  return v === "hypothetical" || v === "business";
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "hypothetical";
  const raw = window.sessionStorage.getItem(MODE_STORAGE_KEY);
  return isMode(raw) ? raw : "hypothetical";
}

function loadRounds(): number {
  if (typeof window === "undefined") return DEFAULT_ROUNDS;
  const raw = window.sessionStorage.getItem(ROUNDS_STORAGE_KEY);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return ROUND_OPTIONS.includes(n as (typeof ROUND_OPTIONS)[number]) ? n : DEFAULT_ROUNDS;
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
  // `hydrated` gates the persist-on-change effects so they don't run on the
  // first commit (when state still holds the SSR-default values) and clobber
  // the real persisted values before the hydrate effect can `setRounds(...)`
  // / `setDraft(...)` / `setMode(...)`. Without this guard, navigating back
  // to /compose silently resets every persisted field to its default.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from sessionStorage on mount. P1's safety-net auto-seed is gone:
  // hypothetical mode (the new default) doesn't need an audience at all, and
  // business mode now seeds inside onRun if needed.
  useEffect(() => {
    setAudience(loadAudience());
    setDraft(loadDraft());
    setMode(loadMode());
    setRounds(loadRounds());
    setHydrated(true);
  }, []);

  // Persist rounds choice so it survives /compose remounts and a navigate-back.
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    window.sessionStorage.setItem(ROUNDS_STORAGE_KEY, String(rounds));
  }, [rounds, hydrated]);

  // Keep the draft in sessionStorage as the user types so /report can return.
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    window.sessionStorage.setItem("echo:draft", draft);
  }, [draft, hydrated]);

  // Persist selected mode so /simulating (and a refresh of /compose) can read it.
  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    window.sessionStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode, hydrated]);

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

  const chipStyle = {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 6,
    whiteSpace: "nowrap" as const,
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    color: "var(--fg-2)",
    position: "relative" as const,
  };
  const selectStyle = {
    appearance: "none" as const,
    WebkitAppearance: "none" as const,
    MozAppearance: "none" as const,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--fg-2)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    paddingRight: 18,
    cursor: "pointer",
  };
  const chevronStyle = {
    opacity: 0.6,
    position: "absolute" as const,
    right: 10,
    pointerEvents: "none" as const,
  };

  const audienceSlot = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={chipStyle}>
        <Icon name="users" size={13} />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          style={selectStyle}
          aria-label="Simulation mode"
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={12} style={chevronStyle} />
      </span>
      <span style={chipStyle}>
        <Icon name="refresh" size={13} />
        <span style={{ fontSize: 12, color: "var(--fg-2)" }}>rounds</span>
        <select
          value={rounds}
          onChange={(e) => setRounds(Number.parseInt(e.target.value, 10))}
          style={{ ...selectStyle, fontFamily: "var(--font-mono)" }}
          aria-label="Number of rounds"
        >
          {ROUND_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={12} style={chevronStyle} />
      </span>
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
          audienceSlot={audienceSlot}
          onRun={onRun}
          disabled={submitting}
        />

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
