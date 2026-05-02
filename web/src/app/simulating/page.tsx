"use client";
// 03 — Rounds (live swarm thread, driven by /simulate/stream SSE).
// S1 (2026-05-02): post-SSE flow no longer redirects to /report — the right
// column transitions in place SwarmMap → spinner → ReportBody, with a subtle
// fullscreen icon as the escape hatch. Replay mode fetches the report up
// front so both columns render together from frame 1.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Icon } from "@/components/ui/Primitives";
import { ReportSidePanel } from "@/components/ReportSidePanel";
import { SEED_DRAFT, SwarmThread } from "@/components/SwarmThread";
import type { SortMode } from "@/lib/tree-builder";
import {
  api,
  ApiError,
  type GroundingEvent,
  type ReportResponse,
  type RoundEvent,
  type ServerPost,
  type SimulateStartResponse,
  type SimulationMode,
  type StreamErrorEvent,
} from "@/lib/api";
import { RequireAuth } from "@/components/auth/RequireAuth";

const MODE_STORAGE_KEY = "echo:mode";

function isMode(v: string | null): v is SimulationMode {
  return v === "hypothetical" || v === "business";
}

function loadMode(): SimulationMode {
  if (typeof window === "undefined") return "business";
  const raw = window.sessionStorage.getItem(MODE_STORAGE_KEY);
  return isMode(raw) ? raw : "business";
}

const DEFAULT_ROUNDS = 5;
// Q3 paced ingest: per-round gap = 1800ms ± jitter(-300, +600).
const MIN_ROUND_VISIBLE_MS = 1800;
const ROUND_JITTER_MIN_MS = -300;
const ROUND_JITTER_MAX_MS = 600;
function jitteredGap(): number {
  const span = ROUND_JITTER_MAX_MS - ROUND_JITTER_MIN_MS;
  return MIN_ROUND_VISIBLE_MS + ROUND_JITTER_MIN_MS + Math.random() * span;
}

// S1 — phase machine: streaming → report-pending → (ready | report-failed).
type Phase = "streaming" | "report-pending" | "report-failed" | "ready";

interface ErrorState {
  code: string;
  message: string;
}

function loadSimulation(): SimulateStartResponse | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem("echo:simulation");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SimulateStartResponse;
  } catch {
    return null;
  }
}

function loadDraft(): string {
  if (typeof window === "undefined") return SEED_DRAFT;
  return window.sessionStorage.getItem("echo:draft") ?? SEED_DRAFT;
}

function errorCopy(code: string): string {
  switch (code) {
    case "budget_exceeded":
      return "Simulation hit the safety limit. Please retry.";
    case "gemini_unavailable":
      return "Upstream model unavailable. Retrying may help.";
    case "simulation_timed_out":
      return "Simulation took too long. Please retry.";
    default:
      return "Something went wrong running the simulation. Please retry.";
  }
}

// Z8 — subtle "searching the web for context…" banner shown above the
// thread while the v8 grounding pre-call runs. Renders one of four states
// per CONTRACTS.md §31. Disappears as soon as the first round event lands
// (handled in the SSE handler) or after a short timeout for terminal
// states. Pure CSS animations — no extra deps.
function GroundingBanner({ state }: { state: GroundingEvent }) {
  let icon: string;
  let label: string;
  let iconColor: string;

  switch (state.status) {
    case "searching":
      icon = "🔍";
      label = "Searching the web for context…";
      iconColor = "var(--accent-300)";
      break;
    case "done":
      icon = "✓";
      label = `Context: ${state.chars_added} chars added`;
      iconColor = "var(--accent-300)";
      break;
    case "skipped":
      icon = "ℹ";
      label = "No web context relevant";
      iconColor = "var(--fg-3)";
      break;
    case "failed":
      icon = "⚠";
      label = "Web grounding failed — proceeding without context";
      iconColor = "var(--warning, #f0b85a)";
      break;
  }

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        role="status"
        aria-live="polite"
        style={{
          minWidth: 360,
          maxWidth: 420,
          padding: "8px 14px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
          fontSize: 12,
          color: "var(--fg-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          animation: "echo-grounding-fade-in 200ms ease-out both",
        }}
      >
        <span
          aria-hidden
          style={{
            color: iconColor,
            fontSize: 13,
            lineHeight: 1,
            ...(state.status === "searching"
              ? {
                  animation:
                    "echo-grounding-pulse 1.6s ease-in-out infinite",
                }
              : {}),
          }}
        >
          {icon}
        </span>
        <span>{label}</span>
      </div>
    </div>
  );
}

function SimulatingInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const isReplay = searchParams.get("replay") === "1";

  const [round, setRound] = useState(1);
  const [maxRounds, setMaxRounds] = useState<number>(DEFAULT_ROUNDS);
  const [posts, setPosts] = useState<ServerPost[]>([]);
  const [running, setRunning] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [draft, setDraft] = useState(SEED_DRAFT);
  const [phase, setPhase] = useState<Phase>("streaming");
  const [report, setReport] = useState<ReportResponse | null>(null);
  // Default "business" preserves @notion attribution for legacy/unset cases.
  // Live hydrates from sessionStorage; replay overwrites from server payload.
  const [mode, setMode] = useState<SimulationMode>("business");
  // Z8 — web-grounding loading-state banner. Null = no banner.
  const [groundingState, setGroundingState] = useState<GroundingEvent | null>(
    null,
  );
  // R2 — top-level thread ordering. Live starts arrival; replay starts
  // engagement since the final state is already known.
  const [sortMode, setSortMode] = useState<SortMode>(
    isReplay ? "engagement" : "arrival",
  );
  const sourceRef = useRef<EventSource | null>(null);

  // Paced ingest (Q3 / L10): queue + drain at jittered cadence so SSE bursts
  // don't collapse into one paint.
  const queueRef = useRef<RoundEvent[]>([]);
  const doneSeenRef = useRef(false);
  const lastAppliedAtRef = useRef(0);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportInFlightRef = useRef(false); // Q2 unmount/remount guard

  useEffect(() => {
    if (isReplay) return;
    const sim = loadSimulation();
    if (sim && typeof sim.rounds === "number") setMaxRounds(sim.rounds);
    setDraft(loadDraft());
    setMode(loadMode());
  }, [isReplay]);

  // S1 — kick /report POST and transition into inline `ready` when it lands.
  // Memoized so Retry can re-fire from the failed state. R2 also flips top
  // sort to engagement-DESC so the SwarmThread FLIP animates the re-sort.
  const kickReport = useCallback((simId: string) => {
    if (reportInFlightRef.current) return;
    reportInFlightRef.current = true;
    setPhase("report-pending");
    setSortMode("engagement");
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.generateReport({ simulation_id: simId });
        if (cancelled) return;
        setReport(result);
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        // 409 report_pending: benign StrictMode race; retry once.
        if (e instanceof ApiError && e.code === "report_pending") {
          try {
            const result = await api.generateReport({ simulation_id: simId });
            if (cancelled) return;
            setReport(result);
            setPhase("ready");
            return;
          } catch {
            /* fall through */
          }
        }
        setPhase("report-failed");
      } finally {
        reportInFlightRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!id) {
      setError({ code: "bad_request", message: "Missing simulation id." });
      setRunning(false);
      return;
    }

    // Reset pacing state on (re)mount, regardless of mode.
    queueRef.current = [];
    doneSeenRef.current = false;
    lastAppliedAtRef.current = 0;
    reportInFlightRef.current = false;
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);

    // ---- Shared paced-ingest machinery (used by both live SSE and replay).
    const finish = () => {
      setRunning(false);
      setDone(true);
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      if (!isReplay) {
        kickReport(id);
      }
    };

    const drain = () => {
      drainTimerRef.current = null;
      const next = queueRef.current.shift();
      if (next) {
        setRound(next.round);
        setMaxRounds(next.of);
        setPosts(next.posts);
        lastAppliedAtRef.current = Date.now();
        if (queueRef.current.length > 0) {
          drainTimerRef.current = setTimeout(drain, jitteredGap());
        } else if (doneSeenRef.current) {
          drainTimerRef.current = setTimeout(finish, jitteredGap());
        }
        return;
      }
      if (doneSeenRef.current) finish();
    };

    const scheduleDrain = () => {
      if (drainTimerRef.current) return;
      const since = Date.now() - lastAppliedAtRef.current;
      const wait =
        lastAppliedAtRef.current === 0
          ? 0
          : Math.max(0, jitteredGap() - since);
      drainTimerRef.current = setTimeout(drain, wait);
    };

    // ---------- Replay mode: fetch persisted sim + report in parallel.
    // Replay drives the paced queue (must succeed); report is best-effort
    // (old sims may not have a cached row). On report failure we drop into
    // report-failed so the side panel can offer a retry.
    if (isReplay) {
      let cancelled = false;
      void (async () => {
        const replayP = api.getReplay(id);
        const reportP = api
          .generateReport({ simulation_id: id })
          .then((r): ReportResponse | null => r)
          .catch(() => null);
        let replay;
        try {
          replay = await replayP;
        } catch (e) {
          if (cancelled) return;
          const message = e instanceof Error ? e.message : "Failed to load replay.";
          setError({ code: "internal_error", message });
          setRunning(false);
          return;
        }
        if (cancelled) return;
        setDraft(replay.draft);
        setMaxRounds(replay.rounds);
        setMode(replay.mode);
        // Partition cumulative posts by round (sorted round asc, id asc per contract).
        const total = replay.rounds;
        for (let r = 1; r <= total; r += 1) {
          const slice = replay.posts.filter((p) => p.round <= r);
          queueRef.current.push({ round: r, of: total, posts: slice });
        }
        doneSeenRef.current = true;
        scheduleDrain();
        setPhase("report-pending");
        const reportResult = await reportP;
        if (cancelled) return;
        if (reportResult) {
          setReport(reportResult);
          setPhase("ready");
        } else {
          setPhase("report-failed");
        }
      })();
      return () => {
        cancelled = true;
        if (drainTimerRef.current) {
          clearTimeout(drainTimerRef.current);
          drainTimerRef.current = null;
        }
      };
    }

    // ---------- Live mode: open EventSource against /simulate/stream.
    // Stream URL is async because we attach a Firebase ID token via query param
    // (EventSource can't send Authorization headers).
    let cancelledLive = false;
    let es: EventSource | null = null;

    const onRound = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as RoundEvent;
        queueRef.current.push(data);
        scheduleDrain();
        // Z8: round events supersede the grounding banner regardless of its
        // current status — the swarm has started and the user's eyes belong
        // on the thread now. Auto-clear timer for terminal grounding states
        // is a fallback in case round 1 takes longer than expected.
        setGroundingState(null);
      } catch {
        // ignore malformed payload — server will close the stream if it's bad
      }
    };

    // Z8 §31-34: subtle banner during the web-grounding pre-call window so
    // users know the ~22s gap before round 1 isn't a hang. Old sims and
    // ungrounded sims simply never emit this event.
    const onGrounding = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as GroundingEvent;
        setGroundingState(data);
        if (data.status !== "searching") {
          const lifetime =
            data.status === "done"
              ? 1500
              : data.status === "skipped"
                ? 2000
                : 3000;
          setTimeout(
            () =>
              setGroundingState((cur) => (cur === data ? null : cur)),
            lifetime,
          );
        }
      } catch {
        // ignore malformed payload
      }
    };

    const onDone = () => {
      doneSeenRef.current = true;
      es?.close();
      if (queueRef.current.length === 0 && !drainTimerRef.current) {
        finish();
      }
    };

    const onErrorEvent = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as StreamErrorEvent;
        setError({ code: data.code, message: data.message });
      } catch {
        setError({ code: "internal_error", message: "Unknown stream error." });
      }
      setRunning(false);
      es?.close();
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
    };

    const onConnectionError = () => {
      if (
        es &&
        es.readyState === EventSource.CLOSED &&
        !error &&
        !done &&
        !doneSeenRef.current
      ) {
        setError({ code: "internal_error", message: "Connection to simulation closed unexpectedly." });
        setRunning(false);
      }
    };

    void (async () => {
      const url = await api.simulateStreamUrl(id);
      if (cancelledLive) return;
      es = new EventSource(url);
      sourceRef.current = es;
      es.addEventListener("round", onRound as EventListener);
      es.addEventListener("grounding", onGrounding as EventListener);
      es.addEventListener("done", onDone as EventListener);
      es.addEventListener("error", onErrorEvent as EventListener);
      es.onerror = onConnectionError;
    })();

    return () => {
      cancelledLive = true;
      es?.close();
      sourceRef.current = null;
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router, isReplay, kickReport]);

  const onPause = () => {
    setRunning(false);
    sourceRef.current?.close();
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
  };

  const onRetry = () => {
    if (!id) return;
    router.push(
      `/simulating?id=${encodeURIComponent(id)}&t=${Date.now()}`,
    );
  };

  const onUseRewrite = (text: string) => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("echo:draft", text);
    }
    router.push("/compose");
  };

  const onFullscreen = () => {
    if (!id) return;
    router.push(`/report?id=${encodeURIComponent(id)}`);
  };

  const baseLabel = error
    ? "Simulation error"
    : running
      ? `Round ${round} of ${maxRounds}`
      : done
        ? isReplay
          ? `Replay · Round ${round} of ${maxRounds}`
          : "Simulation complete"
        : "Paused";
  const topbarLabel =
    isReplay && !error ? `Replay · Round ${round} of ${maxRounds}` : baseLabel;

  // S1 — right-column content is phase-driven. Default (undefined) lets
  // SwarmThread render its built-in SwarmMap.
  const showRightOverride =
    phase === "report-pending" || phase === "report-failed" || phase === "ready";
  const rightPanel = showRightOverride ? (
    <ReportSidePanel
      phase={phase}
      report={report}
      onRetry={() => id && kickReport(id)}
      onFullscreen={onFullscreen}
      onUseRewrite={onUseRewrite}
      canRetry={Boolean(id)}
    />
  ) : undefined;

  return (
    <Frame
      topbarLabel={topbarLabel}
      sidebarActive="compose"
      topbarRight={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {running && !error && (
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
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ flex: 1 }}>
              {errorCopy(error.code)}{" "}
              <span style={{ opacity: 0.7 }}>({error.code})</span>
            </span>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
        {groundingState && <GroundingBanner state={groundingState} />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <SwarmThread
            currentRound={round}
            maxRounds={maxRounds}
            seedDraft={draft}
            running={running}
            posts={posts}
            mode={mode}
            sortMode={sortMode}
            rightPanel={rightPanel}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {running ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="pause" size={11} />}
              onClick={onPause}
            >
              Pause
            </Button>
          ) : phase === "streaming" && !isReplay ? (
            // Edge case: SSE errored or paused before done (so phase never
            // advanced). Keep the legacy "See report" CTA available.
            <Button
              variant="primary"
              size="sm"
              disabled={!done || !id}
              onClick={() =>
                id && router.push(`/report?id=${encodeURIComponent(id)}`)
              }
            >
              See report
            </Button>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}

export default function SimulatingPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <SimulatingInner />
      </Suspense>
    </RequireAuth>
  );
}
