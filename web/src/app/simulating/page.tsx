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

    const onRound = (ev: MessageEvent<string>) => {
      try {
        const data = JSON.parse(ev.data) as RoundEvent;
        setRound(data.round);
        setMaxRounds(data.of);
        setPosts(data.posts);
      } catch {
        // ignore malformed payload — server will close the stream if it's bad
      }
    };

    const onDone = () => {
      setRunning(false);
      setDone(true);
      es.close();
      router.push(`/results?id=${encodeURIComponent(id)}`);
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
    };

    const onConnectionError = () => {
      // EventSource native error (network drop, server closed without `error` event).
      // If we already saw `done` or a server-emitted error, leave state alone.
      if (es.readyState === EventSource.CLOSED && !error && !done) {
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router]);

  const onPause = () => {
    setRunning(false);
    sourceRef.current?.close();
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
