"use client";

// SwarmThread — two-column layout: X-style thread (left, 60%) + ambient
// "room" force-graph (right, 40%, dimmed). The thread is the hero; the room
// is supporting context. See TweetCard.tsx for the per-post animation logic.

import { useEffect, useState } from "react";
import type { ServerPost, SimulationMode } from "@/lib/api";
import { TweetCard } from "./TweetCard";

type Archetype = "skeptic" | "enthusiast" | "curious" | "practitioner" | "pedant" | "lurker";
type AudienceKind = "target" | "public";

type Agent = {
  id: string;
  name: string;
  handle: string;
  archetype: Archetype;
  audience: AudienceKind;
};

type ThreadEvent = {
  id: string;
  round: number;
  parent: string;
  agent: string;
  sentiment: number;
  text: string;
};

export type { ServerPost };

const SEED_AGENTS: Agent[] = [
  { id: "a1",  name: "audrey lin",  handle: "@audrey_lin",    archetype: "skeptic",      audience: "target" },
  { id: "a2",  name: "m. reid",     handle: "@mreid",         archetype: "enthusiast",   audience: "target" },
  { id: "a3",  name: "caleb",       handle: "@calebnotcaleb", archetype: "curious",      audience: "public" },
  { id: "a4",  name: "jules verne", handle: "@jverne",        archetype: "enthusiast",   audience: "target" },
  { id: "a5",  name: "tia k.",      handle: "@tiakwrites",    archetype: "skeptic",      audience: "public" },
  { id: "a6",  name: "s. pham",     handle: "@sphamsf",       archetype: "practitioner", audience: "target" },
  { id: "a7",  name: "rohan k.",    handle: "@rohan",         archetype: "curious",      audience: "public" },
  { id: "a8",  name: "dani m.",     handle: "@dani_m",        archetype: "pedant",       audience: "public" },
  { id: "a9",  name: "priya s.",    handle: "@priya_s",       archetype: "practitioner", audience: "target" },
  { id: "a10", name: "oren f.",     handle: "@oren",          archetype: "lurker",       audience: "public" },
  { id: "a11", name: "sam c.",      handle: "@samc",          archetype: "skeptic",      audience: "public" },
  { id: "a12", name: "mei l.",      handle: "@meil",          archetype: "enthusiast",   audience: "target" },
];

const THREAD_SCRIPT: ThreadEvent[] = [
  { id: "p1", round: 1, parent: "seed", agent: "a2", sentiment:  0.58, text: "finally. weekly memo > all-hands theatre." },
  { id: "p2", round: 1, parent: "seed", agent: "a1", sentiment: -0.12, text: "monthly memos > quarterly OKRs but you'll still need a way to track outcomes. otherwise it's just velocity theater." },
  { id: "p3", round: 1, parent: "seed", agent: "a4", sentiment:  0.42, text: "saved. doing this." },
  { id: "p4", round: 1, parent: "seed", agent: "a3", sentiment:  0.04, text: "this works for product. how does it work for sales?" },
];

const CLUSTER_CENTERS: Record<Archetype, { x: number; y: number; color: string }> = {
  enthusiast:   { x: -90,  y: -55, color: "#7dd49a" },
  practitioner: { x:  10,  y: -75, color: "#9bc97f" },
  curious:      { x:  90,  y: -25, color: "#b8b8c0" },
  lurker:       { x:  90,  y:  55, color: "#b8b8c0" },
  pedant:       { x:  -5,  y:  85, color: "#e8b75a" },
  skeptic:      { x: -100, y:  35, color: "#f06c5a" },
};

function toneColor(s: number): string {
  return s > 0.15 ? "#7dd49a" : s < -0.15 ? "#f06c5a" : "#b8b8c0";
}

// Small helper: round any svg coord to 2 decimals so SSR (Node V8) and
// hydration (browser V8) emit the same string. Some Math.cos/sin chains
// previously diverged at the 14th decimal place and tripped React's
// hydration mismatch warning on cx attributes.
function r2(n: number): string {
  return n.toFixed(2);
}

function agentPoint(agentId: string, archetype: Archetype): { x: number; y: number; color: string } {
  const center = CLUSTER_CENTERS[archetype] || CLUSTER_CENTERS.lurker;
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  const a = ((h % 1000) / 1000) * Math.PI * 2;
  const r = 14 + (((h >> 10) % 1000) / 1000) * 22;
  return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, color: center.color };
}

function normalize(
  posts: ServerPost[] | undefined,
  currentRound: number,
): { events: ThreadEvent[]; agents: Agent[] } {
  if (posts === undefined) {
    return {
      events: THREAD_SCRIPT.filter((p) => p.round <= currentRound),
      agents: SEED_AGENTS,
    };
  }
  const filtered = posts.filter((p) => p.round <= currentRound);
  const events: ThreadEvent[] = filtered.map((p) => ({
    id: p.id, round: p.round, parent: p.parent, agent: p.agent.id,
    sentiment: p.sentiment, text: p.text,
  }));
  const seen = new Set<string>();
  const agents: Agent[] = [];
  for (const p of filtered) {
    if (seen.has(p.agent.id)) continue;
    seen.add(p.agent.id);
    agents.push({
      id: p.agent.id, name: p.agent.name, handle: p.agent.handle,
      archetype: p.agent.archetype, audience: p.agent.audience,
    });
  }
  return { events, agents };
}

export function SwarmThread({
  currentRound = 5,
  maxRounds = 5,
  seedDraft,
  running = false,
  posts,
  mode = "business",
}: {
  currentRound?: number;
  maxRounds?: number;
  seedDraft: string;
  running?: boolean;
  posts?: ServerPost[];
  mode?: SimulationMode;
}) {
  void maxRounds;
  const { events, agents } = normalize(posts, currentRound);
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const lookup = (id: string): Agent | undefined => agentMap.get(id);

  type Edge = { from: { x: number; y: number }; to: { x: number; y: number }; sentiment: number };
  const edges: Edge[] = events
    .map((p): Edge | null => {
      const ag = lookup(p.agent);
      if (!ag) return null;
      const me = agentPoint(ag.id, ag.archetype);
      if (p.parent === "seed") return { from: me, to: { x: 0, y: 0 }, sentiment: p.sentiment };
      const parent = events.find((x) => x.id === p.parent);
      if (!parent) return null;
      const pAg = lookup(parent.agent);
      if (!pAg) return null;
      const them = agentPoint(pAg.id, pAg.archetype);
      return { from: me, to: them, sentiment: p.sentiment };
    })
    .filter((e): e is Edge => e !== null);

  const childCounts: Record<string, number> = {};
  events.forEach((p) => { childCounts[p.parent] = (childCounts[p.parent] || 0) + 1; });
  const dogpileIds = new Set(
    Object.entries(childCounts)
      .filter(([k, v]) => k !== "seed" && v >= 2)
      .map(([k]) => k),
  );

  return (
    // 60/40 split favoring the thread — the room is now supporting context.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", gap: 16, height: "100%" }}>
      <ThreadColumn seedDraft={seedDraft} posts={events} lookup={lookup} mode={mode} />
      <SwarmMap posts={events} edges={edges} dogpileIds={dogpileIds} running={running} agents={agents} />
    </div>
  );
}

function ThreadColumn({
  seedDraft,
  posts,
  lookup,
  mode = "business",
}: {
  seedDraft: string;
  posts: ThreadEvent[];
  lookup: (id: string) => Agent | undefined;
  mode?: SimulationMode;
}) {
  // Shared "now" tick (5s cadence) so all TweetCards refresh their relative
  // timestamps in lockstep without each running its own setInterval.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  // Build parent-handle lookup so each TweetCard can render "Replying to @x".
  const parentHandleOf = (parentId: string): string | undefined => {
    if (parentId === "seed") return undefined;
    const parentPost = posts.find((p) => p.id === parentId);
    if (!parentPost) return undefined;
    const ag = lookup(parentPost.agent);
    return ag?.handle;
  };

  // Perf scope-down per task brief: only the most recent ~10 posts get the
  // animated +1 like floaters and grow-in counts. Older posts show their
  // final like count statically. Caps simultaneous animations regardless of
  // total post count (rounds=15 ≈ 90 posts).
  const LIVE_WINDOW = 10;
  const liveCutoff = Math.max(0, posts.length - LIVE_WINDOW);

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 14, color: "var(--fg-1)", fontWeight: 600 }}>The thread</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
          {posts.length} {posts.length === 1 ? "reply" : "replies"}
        </span>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingRight: 4,
        }}
      >
        {/* Seed post — kept simple so the user's draft visually anchors the thread. */}
        <div
          style={{
            background: "var(--bg-deep)",
            border: "1px solid var(--border)",
            borderLeft: "2px solid var(--accent-200)",
            borderRadius: 12,
            padding: "12px 14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            {mode === "hypothetical" ? (
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}>the scenario</span>
            ) : (
              <>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}>your post</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>@notion</span>
              </>
            )}
          </div>
          <div style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.5 }}>{seedDraft}</div>
        </div>

        {posts.map((p, i) => {
          const ag = lookup(p.agent);
          if (!ag) return null;
          const liveAnimations = i >= liveCutoff;
          return (
            <TweetCard
              key={p.id}
              post={{
                id: p.id,
                parent: p.parent,
                round: p.round,
                text: p.text,
                sentiment: p.sentiment,
              }}
              agent={{
                id: ag.id,
                name: ag.name,
                handle: ag.handle,
                archetype: ag.archetype,
              }}
              parentHandle={parentHandleOf(p.parent)}
              now={now}
              liveAnimations={liveAnimations}
            />
          );
        })}
      </div>
    </div>
  );
}

function SwarmMap({
  posts,
  edges,
  dogpileIds,
  running,
  agents,
}: {
  posts: ThreadEvent[];
  edges: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; sentiment: number }>;
  dogpileIds: Set<string>;
  running: boolean;
  agents: Agent[];
}) {
  const VW = 360;
  const VH = 280;
  const activeAgents = new Set(posts.map((p) => p.agent));
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const dogpilePositions = posts
    .filter((p) => dogpileIds.has(p.id))
    .map((p) => {
      const ag = agentMap.get(p.agent);
      return ag ? agentPoint(ag.id, ag.archetype) : null;
    })
    .filter((v): v is { x: number; y: number; color: string } => Boolean(v));

  return (
    // De-emphasized per Q3 design priority 5: lower overall opacity, smaller
    // dots, dimmer connecting lines. Thread is the hero now.
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflow: "hidden",
        opacity: 0.78,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>The room</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
          {activeAgents.size} / 200 engaged
        </span>
      </div>

      <div
        style={{
          flex: 1,
          position: "relative",
          background:
            "radial-gradient(circle at center, rgba(212,255,92,0.03) 0%, transparent 65%), var(--bg-deep)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          minHeight: 200,
        }}
      >
        <svg
          viewBox={`${-VW / 2} ${-VH / 2} ${VW} ${VH}`}
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0 }}
        >
          {Object.entries(CLUSTER_CENTERS).map(([k, c]) => (
            <circle key={k} cx={r2(c.x)} cy={r2(c.y)} r={48} fill={c.color} opacity={0.04} />
          ))}

          {edges.map((e, i) => (
            <line
              key={i}
              x1={r2(e.from.x)}
              y1={r2(e.from.y)}
              x2={r2(e.to.x)}
              y2={r2(e.to.y)}
              stroke={toneColor(e.sentiment)}
              strokeWidth={0.5}
              opacity={0.32}
            />
          ))}

          {agents.map((a) => {
            const p = agentPoint(a.id, a.archetype);
            const active = activeAgents.has(a.id);
            return (
              <g key={a.id}>
                <circle
                  cx={r2(p.x)}
                  cy={r2(p.y)}
                  r={active ? 2.4 : 1.6}
                  fill={active ? p.color : "#2e2e34"}
                  opacity={active ? 0.85 : 0.4}
                  style={{
                    animationName: active && running ? "echo-pulse" : "none",
                    animationDuration: "1.6s",
                    animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
                    animationIterationCount: "infinite",
                  }}
                />
              </g>
            );
          })}

          {Array.from({ length: 80 }).map((_, idx) => {
            const angle = (idx / 80) * Math.PI * 2 + (idx % 5) * 0.13;
            const radius = 20 + (idx % 9) * 12;
            const x = Math.cos(angle) * radius * 1.3;
            const y = Math.sin(angle) * radius * 1.0;
            return <circle key={`f${idx}`} cx={r2(x)} cy={r2(y)} r={1} fill="#43434b" opacity={0.4} />;
          })}

          <circle cx="0" cy="0" r={6} fill="rgba(11,11,12,0.95)" stroke="var(--accent-200)" strokeWidth={1} />
          <circle
            cx="0"
            cy="0"
            r={2}
            fill="var(--accent-200)"
            style={{
              animationName: "echo-pulse",
              animationDuration: "1.6s",
              animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
              animationIterationCount: "infinite",
            }}
          />

          {dogpilePositions.map((p, i) => (
            <circle
              key={`dp${i}`}
              cx={r2(p.x)}
              cy={r2(p.y)}
              r={8}
              fill="none"
              stroke="var(--accent-200)"
              strokeWidth={0.8}
              opacity={0.6}
              style={{
                animationName: "echo-ripple",
                animationDuration: "2.4s",
                animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
                animationIterationCount: "infinite",
                animationDelay: `${(i * 0.3).toFixed(2)}s`,
                transformOrigin: `${r2(p.x)}px ${r2(p.y)}px`,
              }}
            />
          ))}
        </svg>

        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            display: "flex",
            gap: 10,
            alignItems: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--fg-3)",
            background: "rgba(7,7,8,0.55)",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#7dd49a" }} /> positive
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#f06c5a" }} /> skeptic
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              paddingLeft: 6,
              borderLeft: "1px solid var(--border)",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, border: "1px solid var(--accent-200)" }} /> your audience
          </span>
        </div>
      </div>
    </div>
  );
}

export const SEED_DRAFT =
  "Notion is replacing all-hands with a written weekly memo. Meetings are a tax on focus. We'd rather ship.";
