"use client";

// TweetCard — X-style post card with word-by-word typing reveal and organic
// like animations. Spawned by SwarmThread once per visible post; keyed by
// post.id so React preserves the instance across paced cumulative re-renders
// (thus animations fire exactly once per post per session — see L13/L10
// rationale in .team/LEARNINGS.md).

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./ui/Primitives";

type Archetype =
  | "skeptic" | "enthusiast" | "curious" | "practitioner" | "pedant" | "lurker";

const ARCHETYPE_RING: Record<Archetype, string> = {
  enthusiast:   "#7dd49a",
  practitioner: "#9bc97f",
  curious:      "#b8b8c0",
  lurker:       "#9a9aa3",
  pedant:       "#e8b75a",
  skeptic:      "#f06c5a",
};

// Probability that a given post receives ANY likes, archetype-weighted.
// Enthusiasts/lurkers cheer; skeptics/pedants don't dish out hearts.
const LIKE_PROBABILITY: Record<Archetype, number> = {
  enthusiast:   0.78,
  lurker:       0.62,
  curious:      0.5,
  practitioner: 0.42,
  skeptic:      0.22,
  pedant:       0.22,
};

// Max like count when a post DOES get likes (random in [1, max]).
const LIKE_MAX: Record<Archetype, number> = {
  enthusiast:   28,
  lurker:       20,
  curious:      14,
  practitioner: 10,
  skeptic:      6,
  pedant:       5,
};

// FNV-1a + mulberry32 — deterministic seeded PRNG so the same post id always
// gets the same like count + jitter, making replays match the live render.
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function formatRelative(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function getInitials(name: string): string {
  return name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
}

function toneColor(s: number): string {
  return s > 0.15 ? "#7dd49a" : s < -0.15 ? "#f06c5a" : "#b8b8c0";
}

export interface TweetCardPost {
  id: string;
  parent: string;
  round: number;
  text: string;
  sentiment: number;
}

export interface TweetCardAgent {
  id: string;
  name: string;
  handle: string;
  archetype: Archetype;
}

export interface TweetCardProps {
  post: TweetCardPost;
  agent: TweetCardAgent;
  parentHandle?: string;
  // Shared "now" tick from parent (5s cadence) so we don't run 90 setIntervals.
  now: number;
  // True for posts within the last ~10 in the visible feed — they get the
  // animated +1 floaters and grow-in like counts. Older posts show static
  // counts immediately. This is the perf scope-down for rounds=15 sims.
  liveAnimations: boolean;
}

type Phase = "dots" | "streaming" | "done";

// Word-by-word reveal duration scales with word count; clamped to [600, 1200]
// so short reactions feel snappy and long ones don't overrun the 1.8s pacing
// gap. Keep both ends inside the gap so the next post starts streaming on
// a fresh card, not on top of an in-flight animation.
function typingDurationMs(wordCount: number): number {
  return Math.max(600, Math.min(1200, wordCount * 55));
}

function TweetCardImpl({
  post,
  agent,
  parentHandle,
  now,
  liveAnimations,
}: TweetCardProps) {
  // Mount time captured ONCE; relative timestamp ("12s") is computed against
  // the parent's `now` tick so all visible cards stay in sync without each
  // card running its own interval.
  const mountedAtRef = useRef<number>(Date.now());

  // Pre-tokenize: keep whitespace tokens so we can render partial reveals
  // without losing word boundaries.
  const tokens = useMemo(() => post.text.split(/(\s+)/), [post.text]);
  const wordTokenCount = useMemo(
    () => tokens.reduce((n, t) => n + (t.trim().length > 0 ? 1 : 0), 0),
    [tokens],
  );

  const [phase, setPhase] = useState<Phase>("dots");
  const [wordsShown, setWordsShown] = useState<number>(0);

  // Deterministic per-post seed → same like count on every render / replay.
  const seed = useMemo(() => hashStr(post.id + agent.archetype), [post.id, agent.archetype]);
  const targetLikes = useMemo(() => {
    const r = mulberry32(seed);
    const probability = LIKE_PROBABILITY[agent.archetype] ?? 0.3;
    if (r() >= probability) return 0;
    const max = LIKE_MAX[agent.archetype] ?? 8;
    return 1 + Math.floor(r() * max);
  }, [seed, agent.archetype]);

  // Static fallback for non-recent posts: show the final like count instantly,
  // skip floater animations entirely.
  const [shownLikes, setShownLikes] = useState<number>(liveAnimations ? 0 : targetLikes);
  const [floaters, setFloaters] = useState<{ id: number; x: number }[]>([]);
  const floaterIdRef = useRef<number>(0);
  const popKeyRef = useRef<number>(0);
  const [popKey, setPopKey] = useState<number>(0);

  // Phase 1: typing dots → streaming. Pre-typing dots indicator runs for
  // 300-500ms (jitter from seed) before words start appearing.
  useEffect(() => {
    const dotsDelay = 300 + (seed % 200);
    const t = setTimeout(() => setPhase("streaming"), dotsDelay);
    return () => clearTimeout(t);
  }, [seed]);

  // Phase 2: word-by-word reveal. Total duration scaled to word count, then
  // sliced into per-word setTimeouts. Cleanup on unmount cancels pending
  // ticks so a fast nav-away doesn't leak.
  useEffect(() => {
    if (phase !== "streaming") return;
    if (wordTokenCount === 0) {
      setPhase("done");
      return;
    }
    const total = typingDurationMs(wordTokenCount);
    const interval = total / wordTokenCount;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      i += 1;
      setWordsShown(i);
      if (i >= wordTokenCount) {
        setPhase("done");
        return;
      }
      timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, interval);
    return () => clearTimeout(timer);
  }, [phase, wordTokenCount]);

  // Phase 3: organic like accrual. First like 1.5–4s after mount; subsequent
  // likes spaced 250–1350ms apart with a jitter envelope, capped at 9s total.
  // Each tick spawns a +1 floater that self-destructs after the CSS animation
  // (750ms) so we never leak DOM nodes.
  useEffect(() => {
    if (!liveAnimations) return;
    if (targetLikes === 0) return;
    const r = mulberry32(seed ^ 0xa5a5);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 1500 + r() * 2500;
    for (let i = 0; i < targetLikes; i += 1) {
      const t = setTimeout(() => {
        setShownLikes((c) => c + 1);
        const fid = (floaterIdRef.current += 1);
        const x = -7 + r() * 14;
        setFloaters((cur) => [...cur, { id: fid, x }]);
        const cleanupTimer = setTimeout(() => {
          setFloaters((cur) => cur.filter((f) => f.id !== fid));
        }, 800);
        timers.push(cleanupTimer);
        popKeyRef.current += 1;
        setPopKey(popKeyRef.current);
      }, elapsed);
      timers.push(t);
      elapsed += 250 + r() * 1100;
      if (elapsed > 9000) break;
    }
    return () => timers.forEach(clearTimeout);
  }, [liveAnimations, targetLikes, seed]);

  const ringColor = ARCHETYPE_RING[agent.archetype] ?? "#43434b";
  const relTime = formatRelative(now - mountedAtRef.current);

  // Build visible body: walk tokens, count words, stop after wordsShown.
  let bodyContent: ReactNode;
  if (phase === "dots") {
    bodyContent = <TypingDots />;
  } else {
    const visible: ReactNode[] = [];
    let count = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      const isWord = tok.trim().length > 0;
      if (isWord) {
        if (count >= wordsShown) break;
        count += 1;
      }
      visible.push(<span key={i}>{tok}</span>);
    }
    bodyContent = (
      <>
        {visible}
        {phase === "streaming" && <span className="echo-typing-cursor">▍</span>}
      </>
    );
  }

  const replyCount = (seed % 5);
  const retweetCount = ((seed >> 4) % 4);

  return (
    <article className="echo-tweet">
      <div style={{ display: "flex", gap: 12 }}>
        {/* Avatar with archetype-tinted ring */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 999,
            flexShrink: 0,
            background: "var(--surface-3)",
            border: `1px solid ${ringColor}80`,
            boxShadow: `0 0 0 1px ${ringColor}26 inset`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-1)",
          }}
        >
          {getInitials(agent.name)}
        </div>

        {/* Body column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-1)", letterSpacing: "-0.005em" }}>
              {agent.name}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
              {agent.handle}
            </span>
            <span style={{ color: "var(--fg-4)", fontSize: 12 }}>·</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
              {relTime}
            </span>
            <span
              aria-hidden
              style={{
                marginLeft: "auto",
                width: 6,
                height: 6,
                borderRadius: 999,
                background: toneColor(post.sentiment),
                opacity: 0.85,
              }}
            />
          </div>

          {parentHandle && (
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 1 }}>
              Replying to{" "}
              <span style={{ color: "var(--accent-200)", fontFamily: "var(--font-mono)" }}>
                {parentHandle}
              </span>
            </div>
          )}

          <div
            style={{
              fontSize: 14,
              color: "var(--fg-1)",
              lineHeight: 1.45,
              marginTop: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              minHeight: 20,
            }}
          >
            {bodyContent}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 28,
              marginTop: 10,
              color: "var(--fg-3)",
            }}
          >
            <ActionItem icon="reply" count={replyCount > 0 ? replyCount : undefined} />
            <ActionItem icon="retweet" count={retweetCount > 0 ? retweetCount : undefined} />
            <span className="echo-tweet-like" style={{ position: "relative" }}>
              <ActionItem
                icon={shownLikes > 0 ? "heartFilled" : "heart"}
                count={shownLikes > 0 ? shownLikes : undefined}
                active={shownLikes > 0}
                popKey={popKey}
              />
              {floaters.map((f) => (
                <span
                  key={f.id}
                  className="echo-like-floater"
                  style={{ left: `calc(50% + ${f.x.toFixed(1)}px)` }}
                >
                  +1
                </span>
              ))}
            </span>
            <ActionItem icon="share" />
          </div>
        </div>
      </div>
    </article>
  );
}

function ActionItem({
  icon,
  count,
  active,
  popKey,
}: {
  icon: "reply" | "retweet" | "heart" | "heartFilled" | "share";
  count?: number;
  active?: boolean;
  popKey?: number;
}) {
  const className = `echo-tweet-action ${active && (icon === "heart" || icon === "heartFilled") ? "is-like-active" : ""}`;
  const style: CSSProperties = {};
  return (
    <span className={className} style={style}>
      <span key={popKey ?? 0} style={{ display: "inline-flex" }}>
        <Icon name={icon} size={14} />
      </span>
      {count !== undefined && <span>{count}</span>}
    </span>
  );
}

function TypingDots() {
  return (
    <span className="echo-typing-dots" aria-label="typing">
      <span className="echo-typing-dot" />
      <span className="echo-typing-dot" />
      <span className="echo-typing-dot" />
    </span>
  );
}

export const TweetCard = TweetCardImpl;
