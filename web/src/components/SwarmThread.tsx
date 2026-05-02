"use client";

// SwarmThread — two-column layout: X-style INDENTED thread (left, 60%) +
// ambient "room" force-graph (right, 40%, dimmed). The thread is the hero;
// the room is supporting context. See TweetCard.tsx for the per-post
// animation logic; tree-builder.ts for the pure parent-child grouping;
// SwarmMap.tsx for the right-column visualization; swarm-graph.ts for the
// shared cluster geometry helpers.
//
// v6 / R2 (2026-05-02): rewrote thread column to render top-level posts +
// indented level-1 children with a vertical thread-line. sortMode toggles
// arrival vs engagement-DESC ordering for top-level posts; FLIP animates the
// transition. Sub-thread order stays chronological regardless. Cosmetic
// like-count generation is gone — TweetCard now consumes wire values per
// CONTRACTS v6 §21.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ServerPost, SimulationMode } from "@/lib/api";
import { agentPoint, type Archetype } from "@/lib/swarm-graph";
import { buildThreadGroups, type SortMode } from "@/lib/tree-builder";
import { SwarmMap, type SwarmMapEdge } from "./SwarmMap";
import { TweetCard } from "./TweetCard";

// Z7 — Long-thread reply truncation.
// When a top-level post accumulates a long descendant chain, render only the
// first INITIAL_REPLY_COUNT cards (with the last one masked by a CSS bottom
// fade) and a single "Expand N more replies" pill below. Click expands
// one-way (no collapse-back) for hackathon scope. Per L21 these knobs are
// module-top so subsequent agents tuning the look don't have to hunt.
//
// Note: count is computed against the FLATTENED descendant subtree because
// the renderer flattens level-3+ replies to level-1 visually (see
// tree-builder.ts §"Tree shape"). What the user perceives as "direct
// children" is really "rendered children under the top-level".
const INITIAL_REPLY_COUNT = 2;     // children shown before fade kicks in
const FADE_OPACITY_START = 0.6;    // where the second card's fade-out starts (0..1)
const EXPAND_DURATION_MS = 200;    // slide-down animation duration (ms)

// Pre-stream skeleton — rotating creative status messages shown while the
// thread waits on its very first round event. "waking up" always lands
// first; the rest progress on a steady cadence so the user perceives
// activity even before the swarm streams. Cadence is tuned so the user
// rarely reaches the 5th line before round 1 begins (~12s envelope).
const SKELETON_STATUS_LINES = [
  "echo agents waking up…",
  "echo agents reading the room…",
  "echo agents thinking…",
  "echo agents responding…",
  "echo agents scrolling…",
] as const;
const SKELETON_LINE_DURATION_MS = 2600;
const SKELETON_CARD_COUNT = 3;

type AudienceKind = "target" | "public";

type Agent = {
  id: string;
  name: string;
  handle: string;
  archetype: Archetype;
  audience: AudienceKind;
  // v7 §25 — optional persona richness, surfaced on the avatar hover tooltip
  // in TweetCard. Older sims won't have these and the tooltip is skipped.
  bio?: string;
  profession?: string | null;
  hot_buttons?: string[] | null;
};

type ThreadEvent = {
  id: string;
  round: number;
  parent: string;
  agent: string;
  sentiment: number;
  text: string;
  like_count: number;
  reply_count: number;
  // G2 (CONTRACTS §41) — per-post reaction tag (closed-enum string).
  // Sourced from the wire's per-post `agent.gif_reaction` so each turn carries
  // its own glyph. Optional/nullable: pre-G sims and replays without the
  // field render no glyph (TweetCard's ReactionGlyph returns null on absent).
  gif_reaction?: string | null;
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
  { id: "p1", round: 1, parent: "seed", agent: "a2", sentiment:  0.58, text: "finally. weekly memo > all-hands theatre.", like_count: 0, reply_count: 0 },
  { id: "p2", round: 1, parent: "seed", agent: "a1", sentiment: -0.12, text: "monthly memos > quarterly OKRs but you'll still need a way to track outcomes. otherwise it's just velocity theater.", like_count: 0, reply_count: 0 },
  { id: "p3", round: 1, parent: "seed", agent: "a4", sentiment:  0.42, text: "saved. doing this.", like_count: 0, reply_count: 0 },
  { id: "p4", round: 1, parent: "seed", agent: "a3", sentiment:  0.04, text: "this works for product. how does it work for sales?", like_count: 0, reply_count: 0 },
];

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
    like_count: p.like_count ?? 0, reply_count: p.reply_count ?? 0,
    // G2 — pull per-post tag off the wire-side agent block (CONTRACTS §41).
    // The persona registry is deduped by id so this can't live there; per-
    // post is the right home for a per-turn reaction.
    gif_reaction: p.agent.gif_reaction ?? null,
  }));
  const seen = new Set<string>();
  const agents: Agent[] = [];
  for (const p of filtered) {
    if (seen.has(p.agent.id)) continue;
    seen.add(p.agent.id);
    agents.push({
      id: p.agent.id, name: p.agent.name, handle: p.agent.handle,
      archetype: p.agent.archetype, audience: p.agent.audience,
      bio: p.agent.bio, profession: p.agent.profession,
      hot_buttons: p.agent.hot_buttons,
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
  sortMode = "arrival",
  rightPanel,
}: {
  currentRound?: number;
  maxRounds?: number;
  seedDraft: string;
  running?: boolean;
  posts?: ServerPost[];
  mode?: SimulationMode;
  sortMode?: SortMode;
  // S1 — when set, the right column renders this node instead of the default
  // SwarmMap. /simulating uses this to swap in the inline ReportBody panel
  // (and its pending/failed transitional states) once the SSE stream finishes.
  rightPanel?: ReactNode;
}) {
  void maxRounds;
  const { events, agents } = normalize(posts, currentRound);
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const lookup = (id: string): Agent | undefined => agentMap.get(id);

  const edges: SwarmMapEdge[] = events
    .map((p): SwarmMapEdge | null => {
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
    .filter((e): e is SwarmMapEdge => e !== null);

  const childCounts: Record<string, number> = {};
  events.forEach((p) => { childCounts[p.parent] = (childCounts[p.parent] || 0) + 1; });
  const dogpileIds = new Set(
    Object.entries(childCounts)
      .filter(([k, v]) => k !== "seed" && v >= 2)
      .map(([k]) => k),
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", gap: 16, height: "100%" }}>
      <ThreadColumn
        seedDraft={seedDraft}
        events={events}
        lookup={lookup}
        mode={mode}
        sortMode={sortMode}
      />
      {rightPanel !== undefined ? (
        rightPanel
      ) : (
        <SwarmMap
          posts={events.map((p) => ({ id: p.id, agent: p.agent }))}
          edges={edges}
          dogpileIds={dogpileIds}
          running={running}
          agents={agents}
        />
      )}
    </div>
  );
}

function ThreadColumn({
  seedDraft,
  events,
  lookup,
  mode = "business",
  sortMode,
}: {
  seedDraft: string;
  events: ThreadEvent[];
  lookup: (id: string) => Agent | undefined;
  mode?: SimulationMode;
  sortMode: SortMode;
}) {
  // Shared "now" tick (5s cadence) so all TweetCards refresh their relative
  // timestamps in lockstep without each running its own setInterval.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  // Build the indented tree. Sub-thread order stays chronological regardless
  // of sortMode; only top-level groups respond to engagement-DESC ranking.
  const groups = buildThreadGroups(events, sortMode);

  // Build parent-handle lookup so each TweetCard renders "Replying to @x".
  const parentHandleOf = (parentId: string): string | undefined => {
    if (parentId === "seed") return undefined;
    const parentPost = events.find((p) => p.id === parentId);
    if (!parentPost) return undefined;
    const ag = lookup(parentPost.agent);
    return ag?.handle;
  };

  // Perf scope-down: only the most recent N posts (by arrival/round-id order)
  // get the live heart-pop floaters. Older posts still pick up updated
  // like_counts on render but suppress floater spawning. At rounds=15 / 90
  // posts this keeps re-render cost bounded.
  const LIVE_WINDOW = 10;
  const arrivalSorted = [...events].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  const liveCutoffIdx = Math.max(0, arrivalSorted.length - LIVE_WINDOW);
  const liveSet = new Set(arrivalSorted.slice(liveCutoffIdx).map((p) => p.id));

  // Z7 — per-top-level-post expansion state for the long-thread reply
  // truncation UI. Keyed on post.id so the R2 engagement-DESC re-sort (which
  // reorders top-level groups) doesn't scramble which threads are expanded.
  // One-way (no collapse-back) for hackathon scope. Set is fine here — the
  // membership check is O(1) and React's reference-equality on Set forces a
  // re-render when we copy-and-add on click.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const expandParent = (id: string) => {
    setExpandedParents((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  // FLIP-based animated re-sort. We snapshot top-level group positions on
  // every layout pass; when sortMode flips we use the previous snapshot as
  // the "from" position and animate to the current ("to") via CSS transform.
  // Top-level cards' descendants live inside the same wrapper so they ride
  // along with their parent rather than animating independently.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const positionsRef = useRef<Map<string, DOMRect>>(new Map());
  const prevSortModeRef = useRef<SortMode>(sortMode);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const cards = Array.from(
      el.querySelectorAll<HTMLDivElement>("[data-thread-group]"),
    );

    const newPositions = new Map<string, DOMRect>();
    for (const c of cards) {
      const id = c.dataset.threadGroup;
      if (id) newPositions.set(id, c.getBoundingClientRect());
    }

    if (prevSortModeRef.current !== sortMode) {
      // FLIP — invert each group to its previous position, then RAF-release.
      for (const c of cards) {
        const id = c.dataset.threadGroup;
        if (!id) continue;
        const oldPos = positionsRef.current.get(id);
        const newPos = newPositions.get(id);
        if (!oldPos || !newPos) continue;
        const dx = oldPos.left - newPos.left;
        const dy = oldPos.top - newPos.top;
        if (dx === 0 && dy === 0) continue;
        c.style.transition = "none";
        c.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
        c.style.willChange = "transform";
      }
      // Force reflow so the inverted transform commits before the transition.
      void el.offsetHeight;
      requestAnimationFrame(() => {
        for (const c of cards) {
          c.style.transition =
            "transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          c.style.transform = "";
        }
        // Clean up after the animation settles.
        window.setTimeout(() => {
          for (const c of cards) {
            c.style.transition = "";
            c.style.willChange = "";
          }
        }, 700);
      });
    }

    positionsRef.current = newPositions;
    prevSortModeRef.current = sortMode;
  });

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
          {events.length} {events.length === 1 ? "reply" : "replies"}
          {sortMode === "engagement" && (
            <span style={{ marginLeft: 8, color: "var(--accent-200)" }}>· engagement</span>
          )}
        </span>
      </div>

      <div
        ref={containerRef}
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

        {groups.length === 0 && <ThreadSkeleton />}

        {groups.map((group) => {
          const topAgent = lookup(group.top.agent);
          if (!topAgent) return null;
          return (
            <div
              key={group.top.id}
              data-thread-group={group.top.id}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <TweetCard
                post={{
                  id: group.top.id,
                  parent: group.top.parent,
                  round: group.top.round,
                  text: group.top.text,
                  sentiment: group.top.sentiment,
                  like_count: group.top.like_count,
                  reply_count: group.top.reply_count,
                  gif_reaction: group.top.gif_reaction,
                }}
                agent={{
                  id: topAgent.id,
                  name: topAgent.name,
                  handle: topAgent.handle,
                  archetype: topAgent.archetype,
                  bio: topAgent.bio,
                  profession: topAgent.profession,
                }}
                parentHandle={undefined}
                now={now}
                liveAnimations={liveSet.has(group.top.id)}
              />
              {group.descendants.length > 0 && (() => {
                // Z7 — truncation slicing. We compute `needsTruncation` from
                // the FLATTENED descendant count (the visual rendered count),
                // not from a "direct children only" count, so a long deep
                // chain triggers the same fade as a wide flat one. Recomputed
                // every render → live mode 4th-arrival auto-shows once the
                // count crosses INITIAL_REPLY_COUNT + 1.
                const isExpanded = expandedParents.has(group.top.id);
                const total = group.descendants.length;
                // Truncate when there is at least one card to hide beyond the
                // INITIAL_REPLY_COUNT visible window. With the default of 2
                // visible, this fires at total >= 3 per the spec.
                const needsTruncation = total > INITIAL_REPLY_COUNT;
                const visible = needsTruncation && !isExpanded
                  ? group.descendants.slice(0, INITIAL_REPLY_COUNT)
                  : group.descendants;
                const hiddenCount = total - INITIAL_REPLY_COUNT;
                const fadeMaskStyle: CSSProperties = {
                  WebkitMaskImage: `linear-gradient(to bottom, black 0%, black ${
                    Math.round(FADE_OPACITY_START * 100)
                  }%, transparent 100%)`,
                  maskImage: `linear-gradient(to bottom, black 0%, black ${
                    Math.round(FADE_OPACITY_START * 100)
                  }%, transparent 100%)`,
                };
                return (
                  <div
                    style={{
                      position: "relative",
                      marginLeft: 36,
                      paddingLeft: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {/* Vertical thread-line connecting top-level avatar to children */}
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: "var(--border)",
                        borderRadius: 2,
                      }}
                    />
                    {visible.map((d, idx) => {
                      const ag = lookup(d.agent);
                      if (!ag) return null;
                      // The last visible card under truncation gets the
                      // bottom-fade mask AND skips typing (typing on a
                      // half-faded card looks broken — see brief).
                      const isFadeCard =
                        needsTruncation && !isExpanded && idx === INITIAL_REPLY_COUNT - 1;
                      // Newly-revealed cards (post-expand-click) ride a
                      // 200ms slide-down on top of TweetCard's own fade-in.
                      const isNewlyRevealed = isExpanded && idx >= INITIAL_REPLY_COUNT;
                      const card = (
                        <TweetCard
                          post={{
                            id: d.id,
                            parent: d.parent,
                            round: d.round,
                            text: d.text,
                            sentiment: d.sentiment,
                            like_count: d.like_count,
                            reply_count: d.reply_count,
                            gif_reaction: d.gif_reaction,
                          }}
                          agent={{
                            id: ag.id,
                            name: ag.name,
                            handle: ag.handle,
                            archetype: ag.archetype,
                            bio: ag.bio,
                            profession: ag.profession,
                          }}
                          parentHandle={parentHandleOf(d.parent)}
                          now={now}
                          liveAnimations={!isFadeCard && liveSet.has(d.id)}
                        />
                      );
                      if (isFadeCard) {
                        return (
                          <div key={d.id} style={fadeMaskStyle}>
                            {card}
                          </div>
                        );
                      }
                      if (isNewlyRevealed) {
                        return (
                          <div
                            key={d.id}
                            className="echo-expand-revealed"
                            style={{
                              ["--echo-expand-duration" as string]: `${EXPAND_DURATION_MS}ms`,
                            } as CSSProperties}
                          >
                            {card}
                          </div>
                        );
                      }
                      return <div key={d.id}>{card}</div>;
                    })}
                    {needsTruncation && !isExpanded && (
                      <button
                        type="button"
                        className="echo-expand-button"
                        onClick={() => expandParent(group.top.id)}
                        aria-expanded={false}
                      >
                        Expand {hiddenCount} more {hiddenCount === 1 ? "reply" : "replies"}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Pre-stream placeholder. Renders a small stack of shimmering skeleton cards
// + a single rotating creative status line ("echo agents waking up…" →
// "reading…" → "thinking…" → "responding…"). Mounted by ThreadColumn whenever
// `groups.length === 0`, so it auto-vanishes the moment the first real
// TweetCard renders.
function ThreadSkeleton() {
  const [lineIdx, setLineIdx] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setLineIdx((i) => Math.min(i + 1, SKELETON_STATUS_LINES.length - 1));
    }, SKELETON_LINE_DURATION_MS);
    return () => window.clearInterval(id);
  }, []);

  const line = SKELETON_STATUS_LINES[lineIdx];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        animation: "echo-card-fade-in 240ms var(--ease-out) both",
      }}
    >
      {Array.from({ length: SKELETON_CARD_COUNT }).map((_, i) => {
        // Match TweetCard ratios: 2-3 body lines (varied), header row with
        // name + handle + ts pills, and a 4-icon action row at the bottom.
        const bodyLineWidths =
          i === 0
            ? ["96%", "82%"]
            : i === 1
              ? ["98%", "92%", "64%"]
              : ["88%", "70%"];
        return (
          <div
            key={i}
            style={{
              background: "var(--bg-deep)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "12px 14px",
              display: "flex",
              gap: 12,
              opacity: 1 - i * 0.16,
            }}
          >
            <div className="echo-skel-avatar" />
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                minWidth: 0,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div
                  className="echo-skel-line"
                  style={{ width: 96, height: 12 }}
                />
                <div
                  className="echo-skel-line"
                  style={{ width: 110, height: 11, opacity: 0.55 }}
                />
                <div
                  className="echo-skel-line"
                  style={{ width: 22, height: 10, opacity: 0.4 }}
                />
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                {bodyLineWidths.map((w, j) => (
                  <div
                    key={j}
                    className="echo-skel-line"
                    style={{ width: w, height: 12 }}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 28,
                  marginTop: 2,
                }}
              >
                {Array.from({ length: 4 }).map((_, k) => (
                  <div
                    key={k}
                    className="echo-skel-line"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      opacity: 0.45,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginTop: 6,
          minHeight: 22,
        }}
      >
        <span className="echo-typing-dots" aria-hidden>
          <span className="echo-typing-dot" />
          <span className="echo-typing-dot" />
          <span className="echo-typing-dot" />
        </span>
        <span
          key={line}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-3)",
            letterSpacing: "0.01em",
            animation: "echo-status-cycle-in 320ms var(--ease-out) both",
          }}
        >
          {line}
        </span>
      </div>
    </div>
  );
}

export const SEED_DRAFT =
  "Notion is replacing all-hands with a written weekly memo. Meetings are a tax on focus. We'd rather ship.";
