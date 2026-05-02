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
  // doesn't briefly say "of 5" when the user picked 3).
  useEffect(() => {
    const sim = loadSimulation();
    if (sim && typeof sim.rounds === "number") setMaxRounds(sim.rounds);
    setDraft(loadDraft());
  }, []);

  useEffect(() => {
    if (!id) {
      setError({ code: "bad_request", message: "Missing simulation id." });
      setRunning(false);
      return;
    }

    const url = api.simulateStreamUrl(id);
    const es = new EventSource(url);
    sourceRef.current = es;

    // Reset pacing state on (re)mount.
    queueRef.current = [];
    doneSeenRef.current = false;
    lastAppliedAtRef.current = 0;
    if (drainTimerRef.current) clearTimeout(drainTimerRef.current);
    if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);

    const finishWithLinger = () => {
      if (redirectTimerRef.current) return;          // already scheduled
      setRunning(false);
      setDone(true);
      es.close();
      sourceRef.current = null;
      // Linger so the user sees the final round + completed swarm settle.
      redirectTimerRef.current = setTimeout(() => {
        router.push(`/results?id=${encodeURIComponent(id)}`);
      }, DONE_LINGER_MS);
    };

    const drain = () => {
      drainTimerRef.current = null;
      const next = queueRef.current.shift();
      if (next) {
        setRound(next.round);
        setMaxRounds(next.of);
        setPosts(next.posts);
        lastAppliedAtRef.current = Date.now();
        // Schedule the next drain. If the queue already has more items, wait
        // the full minimum gap. If it's empty, we'll be re-armed by onRound.
        if (queueRef.current.length > 0) {
          drainTimerRef.current = setTimeout(drain, MIN_ROUND_VISIBLE_MS);
        } else if (doneSeenRef.current) {
          // No more rounds inbound and stream closed — finish.
          // Honor MIN_ROUND_VISIBLE_MS for the just-applied round before linger.
          drainTimerRef.current = setTimeout(finishWithLinger, MIN_ROUND_VISIBLE_MS);
        }
        return;
      }
      // Queue empty.
      if (doneSeenRef.current) finishWithLinger();
    };

    const scheduleDrain = () => {
      if (drainTimerRef.current) return;             // already armed
      const since = Date.now() - lastAppliedAtRef.current;
      const wait = lastAppliedAtRef.current === 0
        ? 0                                          // first round paints immediately
        : Math.max(0, MIN_ROUND_VISIBLE_MS - since);
      drainTimerRef.current = setTimeout(drain, wait);
    };

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
      // If queue is empty AND no drain is pending, finish now (with linger).
      // Otherwise the drain loop will call finishWithLinger when it empties.
      if (queueRef.current.length === 0 && !drainTimerRef.current) {
        finishWithLinger();
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
      // EventSource native error (network drop, server closed without `error` event).
      // If we already saw `done` or a server-emitted error, leave state alone.
      if (es.readyState === EventSource.CLOSED && !error && !done && !doneSeenRef.current) {
        setError({ code: "internal_error", message: "Connection to simulation closed unexpectedly." });
        setRunning(false);
      }
    };

    es.addEventListener("round", onRound as EventListener);
    es.addEventListener("done", onDone as EventListener);
    es.addEventListener("error", onErrorEvent as EventListener);
    // The DOM-level "error" listener fires for transport-level errors as a plain Event.
    // EventSource dispatches both — the named "error" event listener above handles
    // server-emitted `event: error` payloads; this onerror covers transport drops.
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
  }, [id, router]);

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

  return (
    <Frame
      topbarLabel={
        error
          ? "Simulation error"
          : running
            ? `Round ${round} of ${maxRounds}`
            : done
              ? "Simulation complete"
              : "Paused"
      }
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
          {running ? (
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
              onClick={() => id && router.push(`/results?id=${encodeURIComponent(id)}`)}
            >
              See analysis
            </Button>
          )}
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
