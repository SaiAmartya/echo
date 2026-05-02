"use client";
// 03 — Rounds (live swarm thread, driven by /simulate/stream SSE)
// Ported from design/echo/project/lib/views.jsx (View03_Rounds)

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Icon } from "@/components/ui/Primitives";
import { SEED_DRAFT, SwarmThread } from "@/components/SwarmThread";
import {
  api,
  ApiError,
  type RoundEvent,
  type ServerPost,
  type SimulateStartResponse,
  type SimulationMode,
  type StreamErrorEvent,
} from "@/lib/api";

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
// Minimum visible time per round so the user actually sees the swarm map
// populate cluster-by-cluster, the thread fill in, and the dogpile rings
// animate. Server cadence is ~1.5s/round under Gemini, but we pace defensively
// in the FE so a fast model (or a future optimization) doesn't collapse the
// signature visualization into a blink. See debugger commit message for why.
//
// Q3: bumped 1.2s → 1.8s baseline + jitter so the X-style typing reveal has
// room to breathe. Per-round gap = 1800ms ± jitter(-300, +600), drawn fresh
// each drain so the cadence doesn't feel mechanical. Typing duration in
// TweetCard caps at ~1.2s (≈70% of the gap floor) so each reply finishes
// before the next card slides in.
const MIN_ROUND_VISIBLE_MS = 1800;
const ROUND_JITTER_MIN_MS = -300;
const ROUND_JITTER_MAX_MS = 600;
function jitteredGap(): number {
  const span = ROUND_JITTER_MAX_MS - ROUND_JITTER_MIN_MS;
  return MIN_ROUND_VISIBLE_MS + ROUND_JITTER_MIN_MS + Math.random() * span;
}
// After the report POSTs back 200, wait this long before navigating to /report
// so the spinner doesn't snap-cut to a dense report page — gives the user a
// moment of "ok, that's done" before the route flip.
const REPORT_READY_LINGER_MS = 500;

// Q2 — phase machine for the post-SSE-done flow.
// streaming → SSE in flight (or replay rendering)
// report-pending → SSE done; POST /report kicked; waiting for backend
// report-failed → /report errored (gemini_unavailable / network); user can retry
type Phase = "streaming" | "report-pending" | "report-failed";

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
  // Default to "business" so the existing @notion attribution keeps appearing
  // for legacy / unset cases. Live mode hydrates from sessionStorage; replay
  // mode overwrites from the /simulate/replay payload.
  const [mode, setMode] = useState<SimulationMode>("business");
  const sourceRef = useRef<EventSource | null>(null);

  // Paced ingest. Server can deliver round events back-to-back when the LLM is
  // hot or short — instead of letting React batch them into a single render
  // (which makes /simulating look broken), we queue and drain at a minimum
  // 1.2s cadence. `doneSeen` is a flag so the drain loop knows when there's
  // no more inbound work and it's safe to schedule the linger + redirect.
  const queueRef = useRef<RoundEvent[]>([]);
  const doneSeenRef = useRef(false);
  const lastAppliedAtRef = useRef(0);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Q2 — guard the report POST against component unmount and re-mount races
  // (StrictMode dev double-mount, route changes mid-flight). Backend handles
  // duplicate POSTs idempotently (per L11 / v3 §12 lock+cache pattern), but
  // we don't want a stale response setting state on a dead component.
  const reportInFlightRef = useRef(false);

  // Pull initial total rounds from sessionStorage if present (so the topbar
  // doesn't briefly say "of 5" when the user picked 3). Skipped in replay mode
  // — replay reads draft + rounds from the server payload instead.
  useEffect(() => {
    if (isReplay) return;
    const sim = loadSimulation();
    if (sim && typeof sim.rounds === "number") setMaxRounds(sim.rounds);
    setDraft(loadDraft());
    setMode(loadMode());
  }, [isReplay]);

  // Q2 — kick the /report POST and gate the redirect on its 200. Memoized so
  // the Retry button can re-fire it from the failed state without remounting
  // the whole effect. `cancelled` is captured per call to keep the latest
  // attempt's response from clobbering state if the user navigates away.
  const kickReport = useCallback(
    (simId: string) => {
      if (reportInFlightRef.current) return;
      reportInFlightRef.current = true;
      setPhase("report-pending");

      let cancelled = false;
      void (async () => {
        try {
          await api.generateReport({ simulation_id: simId });
          if (cancelled) return;
          // Brief settle pause so the spinner doesn't hard-cut to /report.
          if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
          redirectTimerRef.current = setTimeout(() => {
            router.push(`/report?id=${encodeURIComponent(simId)}`);
          }, REPORT_READY_LINGER_MS);
        } catch (e) {
          if (cancelled) return;
          // Surface anything the user can usefully retry (502 gemini, network,
          // generic) as report-failed. The component renders a Retry button.
          // 409 report_pending shouldn't happen here in practice (we only POST
          // once after done), but if it does, treat it as success-pending and
          // navigate — backend lock + cache means /report?id will resolve.
          if (e instanceof ApiError && e.code === "report_pending") {
            redirectTimerRef.current = setTimeout(() => {
              router.push(`/report?id=${encodeURIComponent(simId)}`);
            }, REPORT_READY_LINGER_MS);
            return;
          }
          setPhase("report-failed");
        } finally {
          reportInFlightRef.current = false;
        }
      })();

      return () => {
        cancelled = true;
      };
    },
    [router],
  );

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
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);

    // ---- Shared paced-ingest machinery (used by both live SSE and replay).
    // Live mode: when the queue drains and `done` was seen, we transition into
    // the report-pending phase (Q2): keep the thread visible, render a status
    // panel below it, POST /report, and only redirect after the backend
    // confirms the report exists. The old 2s pre-redirect linger is gone —
    // the report POST IS the linger now (and it usually beats 2s anyway, since
    // run_simulation fires a fire-and-forget /report at end-of-sim per L11).
    // Replay mode: settle into done state and let the user nav back manually;
    // no report POST.
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
          // No more inbound work — finish after honoring this round's gap.
          drainTimerRef.current = setTimeout(finish, jitteredGap());
        }
        return;
      }
      if (doneSeenRef.current) finish();
    };

    const scheduleDrain = () => {
      if (drainTimerRef.current) return;             // already armed
      const since = Date.now() - lastAppliedAtRef.current;
      const wait =
        lastAppliedAtRef.current === 0
          ? 0                                        // first round paints immediately
          : Math.max(0, jitteredGap() - since);
      drainTimerRef.current = setTimeout(drain, wait);
    };

    // ---------- Replay mode: read persisted sim and feed the same paced queue.
    if (isReplay) {
      let cancelled = false;
      void (async () => {
        try {
          const replay = await api.getReplay(id);
          if (cancelled) return;
          setDraft(replay.draft);
          setMaxRounds(replay.rounds);
          setMode(replay.mode);
          // Partition cumulative posts by round into RoundEvent-shaped slices.
          // posts[] is sorted (round asc, id asc) per contract; for each round
          // r we emit the full set of posts where round <= r so the SwarmThread
          // sees the same cumulative ingest it gets over SSE.
          const total = replay.rounds;
          for (let r = 1; r <= total; r += 1) {
            const slice = replay.posts.filter((p) => p.round <= r);
            queueRef.current.push({ round: r, of: total, posts: slice });
          }
          doneSeenRef.current = true;
          scheduleDrain();
        } catch (e) {
          if (cancelled) return;
          const message =
            e instanceof Error ? e.message : "Failed to load replay.";
          setError({ code: "internal_error", message });
          setRunning(false);
        }
      })();
      return () => {
        cancelled = true;
        if (drainTimerRef.current) {
          clearTimeout(drainTimerRef.current);
          drainTimerRef.current = null;
        }
        if (redirectTimerRef.current) {
          clearTimeout(redirectTimerRef.current);
          redirectTimerRef.current = null;
        }
      };
    }

    // ---------- Live mode: open EventSource against /simulate/stream.
    const url = api.simulateStreamUrl(id);
    const es = new EventSource(url);
    sourceRef.current = es;

    const onRound = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as RoundEvent;
        queueRef.current.push(data);
        scheduleDrain();
      } catch {
        // ignore malformed payload — server will close the stream if it's bad
      }
    };

    const onDone = () => {
      doneSeenRef.current = true;
      es.close();
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
      es.close();
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
    };

    const onConnectionError = () => {
      if (es.readyState === EventSource.CLOSED && !error && !done && !doneSeenRef.current) {
        setError({ code: "internal_error", message: "Connection to simulation closed unexpectedly." });
        setRunning(false);
      }
    };

    es.addEventListener("round", onRound as EventListener);
    es.addEventListener("done", onDone as EventListener);
    es.addEventListener("error", onErrorEvent as EventListener);
    es.onerror = onConnectionError;

    return () => {
      es.close();
      sourceRef.current = null;
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
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
    if (redirectTimerRef.current) {
      clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  };

  const onRetry = () => {
    if (!id) return;
    // Re-mount by pushing the same path — useEffect re-runs on the new searchParams ref.
    router.push(`/simulating?id=${encodeURIComponent(id)}&t=${Date.now()}`);
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
  const topbarLabel = isReplay && !error ? `Replay · Round ${round} of ${maxRounds}` : baseLabel;

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
              {errorCopy(error.code)} <span style={{ opacity: 0.7 }}>({error.code})</span>
            </span>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <SwarmThread
            currentRound={round}
            maxRounds={maxRounds}
            seedDraft={draft}
            running={running}
            posts={posts}
            mode={mode}
          />
        </div>
        {/* Q2 — report-readiness status panel. Lives below the SwarmThread,
            above the footer, centered. Only renders for live sims after the
            SSE done event; replay never enters report-pending. */}
        {!isReplay && !error && (phase === "report-pending" || phase === "report-failed") && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: "12px 16px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 13,
              color: "var(--fg-1)",
            }}
          >
            {phase === "report-pending" ? (
              <>
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: "2px solid var(--border-strong)",
                    borderTopColor: "var(--fg-1)",
                    animationName: "echo-spin",
                    animationDuration: "0.8s",
                    animationIterationCount: "infinite",
                    animationTimingFunction: "linear",
                  }}
                />
                <span style={{ color: "var(--fg-2)" }}>Analysis report generating…</span>
              </>
            ) : (
              <>
                <span style={{ color: "#f06c5a" }}>Report generation failed.</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => id && kickReport(id)}
                  disabled={!id}
                >
                  Retry report generation
                </Button>
              </>
            )}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {isReplay ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!id}
              onClick={() => id && router.push(`/report?id=${encodeURIComponent(id)}`)}
            >
              Back to report
            </Button>
          ) : running ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="pause" size={11} />}
              onClick={onPause}
            >
              Pause
            </Button>
          ) : phase === "streaming" ? (
            // Edge case: SSE errored or paused before done (so phase never
            // advanced). Keep the legacy "See report" CTA available.
            <Button
              variant="primary"
              size="sm"
              disabled={!done || !id}
              onClick={() => id && router.push(`/report?id=${encodeURIComponent(id)}`)}
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
    <Suspense fallback={null}>
      <SimulatingInner />
    </Suspense>
  );
}
