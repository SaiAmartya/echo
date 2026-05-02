"use client";
// 03 — Rounds (live swarm thread, driven by /simulate/stream SSE)
// Ported from design/echo/project/lib/views.jsx (View03_Rounds)

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Frame, StepIndicator } from "@/components/Shell";
import { Button, Icon } from "@/components/ui/Primitives";
import { SEED_DRAFT, SwarmThread } from "@/components/SwarmThread";
import {
  api,
  type RoundEvent,
  type ServerPost,
  type SimulateStartResponse,
  type StreamErrorEvent,
} from "@/lib/api";
import { RequireAuth } from "@/components/auth/RequireAuth";

const DEFAULT_ROUNDS = 5;
// Minimum visible time per round so the user actually sees the swarm map
// populate cluster-by-cluster, the thread fill in, and the dogpile rings
// animate. Server cadence is ~1.5s/round under Gemini, but we pace defensively
// in the FE so a fast model (or a future optimization) doesn't collapse the
// signature visualization into a blink. See debugger commit message for why.
const MIN_ROUND_VISIBLE_MS = 1200;
// After receiving `event: done`, wait this long before navigating to /results
// so the user sees the completed swarm settle. Without this the redirect fires
// the same frame the final round paints.
const DONE_LINGER_MS = 2000;

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

  // Pull initial total rounds from sessionStorage if present (so the topbar
  // doesn't briefly say "of 5" when the user picked 3). Skipped in replay mode
  // — replay reads draft + rounds from the server payload instead.
  useEffect(() => {
    if (isReplay) return;
    const sim = loadSimulation();
    if (sim && typeof sim.rounds === "number") setMaxRounds(sim.rounds);
    setDraft(loadDraft());
  }, [isReplay]);

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
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);

    // ---- Shared paced-ingest machinery (used by both live SSE and replay).
    // In live mode the finish step closes the EventSource and schedules a
    // 2s linger before redirecting to /results. In replay mode we just settle
    // into the "done" state and let the user press "Back to results" — no
    // redirect, nothing to close.
    const finish = () => {
      if (redirectTimerRef.current) return;
      setRunning(false);
      setDone(true);
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      if (!isReplay) {
        redirectTimerRef.current = setTimeout(() => {
          router.push(`/report?id=${encodeURIComponent(id)}`);
        }, DONE_LINGER_MS);
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
          drainTimerRef.current = setTimeout(drain, MIN_ROUND_VISIBLE_MS);
        } else if (doneSeenRef.current) {
          // No more inbound work — finish after honoring this round's gap.
          drainTimerRef.current = setTimeout(finish, MIN_ROUND_VISIBLE_MS);
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
          : Math.max(0, MIN_ROUND_VISIBLE_MS - since);
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
    // Stream URL is async because we attach a Firebase ID token via query param
    // (EventSource can't send Authorization headers).
    let cancelledLive = false;
    let es: EventSource | null = null;

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
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router, isReplay]);

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
          />
        </div>
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
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!done || !id}
              onClick={() => id && router.push(`/report?id=${encodeURIComponent(id)}`)}
            >
              See report
            </Button>
          )}
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
