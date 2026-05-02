"use client";

// TweetCard — X-style post card with word-by-word typing reveal and engagement
// signal-driven heart animations. Spawned by SwarmThread once per visible
// post; keyed by post.id so React preserves the instance across paced
// cumulative re-renders + sortMode flips (so animations fire once and the
// FLIP re-sort doesn't unmount cards).
//
// v6 (2026-05-02): cosmetic mulberry32 likes REMOVED. like_count and
// reply_count come from the v6 wire (CONTRACTS §21). FE just renders.
// Heart-pop fires on growth-detection (this render's like_count > prev).

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

// FNV-1a — only used for the cosmetic retweet count (not in scope to remove).
// Likes/replies use real wire values now.
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
  // v6 §21 — wire-supplied engagement counts. Both default 0.
  like_count: number;
  reply_count: number;
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
  // True for posts in the recent-arrivals window — they get the animated +1
  // floaters and pop on growth. Older posts still update their displayed count
  // when like_count grows, but suppress the floater spawn for perf at
  // rounds=15 / 90 posts. Per L21 / task #24 perf scope-down.
  liveAnimations: boolean;
}

type Phase = "dots" | "streaming" | "done";

// Word-by-word reveal duration scales with word count; clamped to [600, 1200]
// so short reactions feel snappy and long ones don't overrun the 1.8s pacing
// gap.
function typingDurationMs(wordCount: number): number {
  return Math.max(600, Math.min(1200, wordCount * 55));
}

// Hard cap on simultaneous +1 floaters per growth event so a +20 jump doesn't
// spawn 20 DOM nodes. Anything past this still bumps the displayed count, just
// without an extra floater.
const MAX_FLOATERS_PER_GROWTH = 5;
const FLOATER_STAGGER_MS = 200;
const FLOATER_LIFETIME_MS = 800;

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

  // Heart-pop growth-detection state.
  // - prevLikeCountRef: last like_count we rendered; compared each update.
  // - hasMountedRef: false on first effect run so initial render doesn't pop.
  //   This matches the brief: "Initial render of an existing post (from
  //   replay): show static like_count, NO heart-pop."
  const prevLikeCountRef = useRef<number>(post.like_count ?? 0);
  const hasMountedRef = useRef<boolean>(false);
  const [popKey, setPopKey] = useState<number>(0);
  const [floaters, setFloaters] = useState<{ id: number; x: number }[]>([]);
  const floaterIdRef = useRef<number>(0);

  // Phase 1: typing dots → streaming. Pre-typing dots indicator runs for
  // ~300-500ms before words start appearing. We use post.id length as a
  // tiny dejitter source so adjacent cards don't synchronise their dots.
  useEffect(() => {
    const seed = hashStr(post.id);
    const dotsDelay = 300 + (seed % 200);
    const t = setTimeout(() => setPhase("streaming"), dotsDelay);
    return () => clearTimeout(t);
  }, [post.id]);

  // Phase 2: word-by-word reveal. Total duration scaled to word count, then
  // sliced into per-word setTimeouts. Cleanup cancels pending ticks.
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

  // Phase 3: heart-pop on like_count growth. Initial mount = prime ref + bail
  // (no animation). Subsequent renders where like_count grew = pop + spawn
  // staggered +1 floaters, capped at MAX_FLOATERS_PER_GROWTH per event.
  // Older (non-live) posts still pick up the new count on render, but don't
  // spawn floaters or fire the pop animation — perf scope-down at rounds=15.
  useEffect(() => {
    const newCount = post.like_count ?? 0;
    if (!hasMountedRef.current) {
      // First effect run after mount — adopt the wire value as baseline,
      // skip animation. Replay's first frame and live's first appearance
      // both land here.
      prevLikeCountRef.current = newCount;
      hasMountedRef.current = true;
      return;
    }
    const oldCount = prevLikeCountRef.current;
    if (newCount > oldCount && liveAnimations) {
      const diff = newCount - oldCount;
      const floaterCount = Math.min(diff, MAX_FLOATERS_PER_GROWTH);
      const timers: ReturnType<typeof setTimeout>[] = [];
      for (let i = 0; i < floaterCount; i += 1) {
        const t = setTimeout(() => {
          const fid = (floaterIdRef.current += 1);
          // Jitter horizontal offset deterministically off the floater id so
          // SSR/hydration agree. Range -7..+7 px around the heart icon.
          const x = -7 + ((fid * 1103515245 + 12345) % 1000) / 1000 * 14;
          setFloaters((cur) => [...cur, { id: fid, x }]);
          setPopKey((k) => k + 1);
          const cleanup = setTimeout(() => {
            setFloaters((cur) => cur.filter((f) => f.id !== fid));
          }, FLOATER_LIFETIME_MS);
          timers.push(cleanup);
        }, i * FLOATER_STAGGER_MS);
        timers.push(t);
      }
      // Cleanup if unmounted mid-stagger.
      // (No return cleanup attached because effect deps include like_count
      // which only changes on growth/no-op; running cleanup of stale timers
      // is fine here — they're idempotent.)
      void timers;
    }
    prevLikeCountRef.current = newCount;
  }, [post.like_count, liveAnimations]);

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

  // Real values from v6 wire.
  const likeCount = post.like_count ?? 0;
  const replyCount = post.reply_count ?? 0;
  // Retweet stays cosmetic per task brief — small deterministic 0..3 range.
  const retweetSeed = hashStr(post.id);
  const retweetCount = (retweetSeed >> 4) % 4;

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
                icon={likeCount > 0 ? "heartFilled" : "heart"}
                count={likeCount > 0 ? likeCount : undefined}
                active={likeCount > 0}
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
