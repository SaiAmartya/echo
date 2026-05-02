"""Echo swarm engine — Gemini-backed multi-round reaction simulator.

HARD CONSTRAINTS (per docs/SWARM-DESIGN.md + .team/CONTRACTS.md):
  * <=40 Gemini calls per simulation. The 41st call raises BudgetExceededError —
    we emit `event: error code=budget_exceeded` and CRASH the sim. Never fan out
    silently.
  * asyncio.Semaphore(MAX_CONCURRENT) shared across all in-flight calls in a
    given simulation (process-global is unnecessary — each sim has its own
    counter, gated by MAX_CONCURRENT_LLM_CALLS env knob, default 6).
  * Model: gemini-2.5-flash-lite ONLY. (env GEMINI_MODEL)
  * response_mime_type="application/json" + response_schema for parse reliability.
  * <=256 output tokens per call (env MAX_TOKENS_PER_CALL).
  * 10s per-call asyncio.wait_for timeout.
  * 90s wallclock for the whole simulation; on breach emit
    `event: error code=simulation_timed_out`.
  * Each archetype call returns 2-4 reactions; one call per archetype per round
    plus one final analysis call. With R=5 rounds: 6*5 + 1 = 31 calls.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import random
import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from dotenv import load_dotenv

from .personas import (
    DEFAULT_DISTRIBUTION,
    Persona,
    build_persona_pool,
    index_by_archetype,
)

# ----------------------------------------------------------------- env / log
load_dotenv()  # loads api/.env — GEMINI_API_KEY, GEMINI_MODEL, etc.

log = logging.getLogger("echo.swarm")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
# v3 (CONTRACTS §13): final aggregate analysis + /report use the thinking model.
# Per-archetype reactions stay on Flash-Lite (cheap + plenty good).
# Verified `gemini-3-flash-preview` via Context7 + ai.google.dev/gemini-api/docs/gemini-3
# (2026-05-02): single model id, thinking enabled via `thinking_config={"thinking_level":...}`.
GEMINI_ANALYSIS_MODEL = os.environ.get("GEMINI_ANALYSIS_MODEL", "gemini-3-flash-preview")
# Web-grounding model — Flash-Lite doesn't support the google_search tool, so
# we use the regular Flash for the single grounding pre-call. Output is plain
# text (response_schema is incompatible with tools=[google_search]).
GEMINI_GROUNDING_MODEL = os.environ.get("GEMINI_GROUNDING_MODEL", "gemini-3-flash-preview")
# Z2 (2026-05-02): v7 sizing math — per-persona-per-round LLM calls.
#   * 50 personas × 8 rounds + 1 genesis + 1 analysis + 1 report  = 403 calls
#   * 100 personas × 10 rounds + 1 genesis + 1 analysis + 1 report = 1003 calls
# v6 path is unchanged: 6 archetypes × 15 rounds + 1 analysis + 1 report = 92.
# Web-grounding adds at most +1 to either path (well inside any cap).
# Default raised 100 → 1200 to admit the upper-bound v7 stress case (100p × 10r)
# with headroom; v6 sims still spend ~92, so the raised cap is a no-op for them.
# api/.env overrides (gitignored) may pin lower for local dev — see L19. The
# Z2 dev test recipe is documented in TaskList #28.
# Z6: ECHO_DEV_MODE=1 shrinks per-sim resource limits 3× for cheap iteration
# during development. Concurrency is intentionally NOT divided — wider fan-out
# doesn't change cost, only wall-clock. With dev-mode on, a default v7 sim
# burns ~139 calls (vs prod ~403) and finishes in ~30s (vs ~85s).
ECHO_DEV_MODE = os.environ.get("ECHO_DEV_MODE", "0") == "1"
_DEV_DIVIDER = 3 if ECHO_DEV_MODE else 1

# G1 (CONTRACTS §§41-45): reaction-GIF feature flag. When False, all gif
# plumbing no-ops (schema field omitted, prompt rule omitted, parser returns
# None, aggregator threading skipped, rarity cap skipped). Default True on
# the experimental/gif-reactions branch; off on main until the FE lands.
ECHO_GIFS_ENABLED = os.environ.get("ECHO_GIFS_ENABLED", "1") == "1"

# G1: canonical 25-tag enum for gif_reaction. Lowercase snake_case. The 25 tags
# are the locked set per CONTRACTS §41 — FE renders each as emoji + a small CSS
# animation. Reused across the response schema, parser validator, and prompt.
GIF_REACTION_TAGS: tuple[str, ...] = (
    "eye_roll", "popcorn", "mind_blown", "this_is_fine", "side_eye",
    "slow_clap", "head_shake", "shrug", "thumbs_up", "thumbs_down",
    "applause", "suspicious", "shocked", "deep_sigh", "mic_drop",
    "facepalm", "laughing", "crying", "nervous", "bored",
    "cheers", "point_up", "no_thanks", "thinking", "wave",
)

MAX_LLM_CALLS = max(50, int(os.environ.get("MAX_LLM_CALLS_PER_SIMULATION", "1200")) // _DEV_DIVIDER)
# Z2: bumped 6 → 12 to absorb the per-persona fan-out. 50 personas at 12-wide
# ≈ 4-5 batches per round; per-call latency ~1-3s on Flash-Lite. v6 round loop
# still gathers 6 archetypes per round so 12 is also a no-op there. Process-
# global semaphore (lazy-bound to the running event loop) so two parallel sims
# share the cap rather than each getting its own 12 slots.
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_LLM_CALLS", "12"))
MAX_TOKENS = int(os.environ.get("MAX_TOKENS_PER_CALL", "256"))
# Z2: server-side display knob for v7 like counts. Default 1 = no scaling. Set
# to e.g. 3 if the LLM-decided per-persona likes feel too sparse for the UI;
# never on the wire as a separate field, only multiplied INTO `like_count`.
# v6 path ignores this constant entirely.
_LIKE_DISPLAY_MULTIPLIER = int(os.environ.get("ECHO_LIKE_DISPLAY_MULTIPLIER", "1"))

# Z6: power-law (Zipfian) transform constants for v7 like counts. Top 10% of
# posts in a round get viral amplification; middle 40% near-unchanged; bottom
# 50% damped to near-zero. v6 path is unaffected — `attach_engagement` already
# produces a natural spread via the affinity matrix.
_LIKE_VIRAL_AMPLIFIER = float(os.environ.get("ECHO_LIKE_VIRAL_AMPLIFIER", "5.0"))
_LIKE_TAIL_DAMPING = float(os.environ.get("ECHO_LIKE_TAIL_DAMPING", "0.3"))
_LIKE_ZIPF_EXPONENT = float(os.environ.get("ECHO_LIKE_ZIPF_EXPONENT", "0.7"))

# Z1 / v7 (CONTRACTS §29): engine version flag. "v6" = current archetype-batched
# engine (default). "v7" = agentic per-persona engine (Z2). Z1 only adds the
# upfront persona-genesis call when v7 is set; the round loop is unchanged
# until Z2 lands. Default stays "v6" so existing behavior is preserved.
ECHO_ENGINE_VERSION = os.environ.get("ECHO_ENGINE_VERSION", "v6").strip().lower()
# Z1 default persona pool size (range [30, 100] enforced at the request boundary).
# Used when v7 + persona_count omitted. Plan #2.
# Z6: scaled by _DEV_DIVIDER — prod 50, dev ~17 — to cut per-sim cost.
DEFAULT_PERSONA_COUNT = int(os.environ.get("ECHO_DEFAULT_PERSONA_COUNT", "50")) // _DEV_DIVIDER

PER_CALL_TIMEOUT = 10.0
# Thinking-model calls: longer ceiling (5-20s typical, occasional 30s+ on
# thinking_level=high). The inline analysis call (run_simulation) uses level=low
# so it stays under WALLCLOCK_TIMEOUT; /report uses level=high (no wallclock).
THINKING_CALL_TIMEOUT = 60.0
# Z2: wallclock 120 → 240s to admit the v7 100p × 10r upper-bound case. v6
# sims still finish in ~30s end-to-end so this is no-op for v6. Genesis adds
# ≈10s, per-round wave (50p / 12-concurrency × ~2s) ≈ 8-12s, so 8 rounds ≈
# 70-100s + analysis (5-15s, thinking_level=low) lands well inside 240s.
# Z6: divided by _DEV_DIVIDER (3× tighter when dev-mode on) — dev sims are
# smaller and should finish well inside ~80s.
WALLCLOCK_TIMEOUT = float(os.environ.get("ECHO_WALLCLOCK_TIMEOUT", "240")) / _DEV_DIVIDER

ARCHETYPES: tuple[str, ...] = (
    "skeptic",
    "enthusiast",
    "curious",
    "practitioner",
    "pedant",
    "lurker",
)


# ----------------------------------------------------- v6 engagement engine
# v6 (CONTRACTS §§21-24, 2026-05-02): real engagement signal on posts.
# Likes are computed deterministically (NO new LLM calls) so the per-sim
# budget stays at ≤100. Same (sim_id, post_id, round) tuple → same
# like_count, every replay (L22 — deterministic PRNG seeded by stable id
# preserves replay parity).
#
# Affinity matrix — rows = scroller archetype (the persona deciding whether
# to like), cols = post author archetype. Values 0..1 are "tendency to like
# a post by that archetype". Calibrated for social-media plausibility:
#   - enthusiasts are the like-button users — they boost everyone, esp. own.
#   - skeptics rarely like; when they do, it's other skeptics (validation)
#     or pedants (precision they respect).
#   - lurkers are mostly receptive; mild boost on enthusiast vibes (energy).
#   - pedants almost never like — they correct, not validate.
#   - practitioners reward other practitioners (peer recognition) and
#     pedants (precision).
#   - curious is moderate across the board (scrolling-engaged but not fan).
_ARCHETYPE_AFFINITY: dict[str, dict[str, float]] = {
    "skeptic":      {"skeptic": 0.45, "enthusiast": 0.15, "curious": 0.25, "practitioner": 0.30, "pedant": 0.40, "lurker": 0.20},
    "enthusiast":   {"skeptic": 0.20, "enthusiast": 0.60, "curious": 0.40, "practitioner": 0.35, "pedant": 0.15, "lurker": 0.50},
    "curious":      {"skeptic": 0.30, "enthusiast": 0.40, "curious": 0.40, "practitioner": 0.40, "pedant": 0.30, "lurker": 0.30},
    "practitioner": {"skeptic": 0.25, "enthusiast": 0.30, "curious": 0.30, "practitioner": 0.55, "pedant": 0.40, "lurker": 0.25},
    "pedant":       {"skeptic": 0.15, "enthusiast": 0.10, "curious": 0.15, "practitioner": 0.20, "pedant": 0.20, "lurker": 0.10},
    "lurker":       {"skeptic": 0.35, "enthusiast": 0.50, "curious": 0.40, "practitioner": 0.40, "pedant": 0.35, "lurker": 0.35},
}


# T1 (2026-05-02): minor divisive-content bias dials. Module-top so the lead
# can tune post-QA without function-body surgery. Both tweaks are deterministic
# (pure functions of existing post sentiments / ids) — no new RNG, replay
# parity preserved (L22).
#
# - _SENT_RESONANCE_PEAK: |sentiment| at which the bell curve in
#   _sentiment_resonance maxes out. Shifted from the original 0.7 to 0.8 so
#   high-magnitude takes (|s|>=0.7) get more lift than bland-but-positive
#   ones; tepid (|s|≈0) is essentially unchanged. resonance(1.0) lifts from
#   ~0.82 → ~0.91 — saturating-extreme posts stop underperforming.
# - _CONTROVERSY_BONUS_MAX: ceiling of the post-pass multiplier applied in
#   attach_engagement to posts whose direct replies disagree (opposite
#   sentiment sign). 0.15 = up to +15% for 100%-opposite-sign children;
#   scaled by fraction so 50/50 → +7.5%, 0/all-same → +0%.
_SENT_RESONANCE_PEAK = 0.8
_CONTROVERSY_BONUS_MAX = 0.15


def _stable_seed(*parts: str) -> int:
    """Deterministic 32-bit seed from string parts.

    Uses hashlib.md5 (process-stable) instead of Python's hash() because
    hash() is PYTHONHASHSEED-salted by default in CPython 3.x — replays
    across process restarts would diverge. md5 is sufficient for jitter
    seeding (we are not using it as a security primitive).
    """
    digest = hashlib.md5(":".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def _visibility_factor(current_round: int, post_round: int) -> float:
    """Recency decay — post seen most when fresh, less in later rounds."""
    delta = current_round - post_round
    if delta <= 0:
        return 1.0
    if delta == 1:
        return 0.5
    if delta == 2:
        return 0.25
    return 0.10


def _sentiment_resonance(sentiment: float) -> float:
    """Bell curve peaked at |s|=_SENT_RESONANCE_PEAK. Tepid (~0) damps;
    saturating-extreme (~1) damps less than before.

    With peak=0.8 (T1, 2026-05-02): resonance(0.0)≈0.44, resonance(0.5)≈0.82,
    resonance(0.7)≈0.98, resonance(0.8)=1.00, resonance(1.0)≈0.91. Pre-T1 the
    peak was 0.7 with resonance(1.0)≈0.82 and resonance(0.0)≈0.48 — the shift
    rewards divisive/extreme takes (real social-media engagement bias) while
    leaving the tepid baseline almost unchanged. The bot-like ceiling at
    |s|=1.0 still damps slightly relative to the peak (0.91 < 1.0).
    """
    s = max(0.0, min(1.0, abs(sentiment)))
    sigma = 0.35
    return 0.4 + 0.6 * math.exp(-((s - _SENT_RESONANCE_PEAK) ** 2) / (2 * sigma ** 2))


def _text_quality(text: str) -> float:
    """Word-count quality proxy — peak 8-25 words, damp short and long.

    Tweet-shaped takes (one or two punchy sentences) drive most engagement.
    Single-word takes feel low-effort; over-long takes get scrolled past.
    """
    n = len((text or "").split())
    if n == 0:
        return 0.3
    if n < 5:
        return 0.4 + 0.05 * n  # 0.4..0.6 over 0..4
    if n <= 15:
        return 0.7 + 0.3 * (n - 5) / 10  # ramp 0.7..1.0
    if n <= 25:
        return 1.0
    if n <= 40:
        return 1.0 - 0.3 * (n - 25) / 15  # 1.0 → 0.7
    return max(0.4, 0.7 - 0.2 * (n - 40) / 20)  # 0.7 → ~0.5


def _per_round_likes(
    *,
    sim_id: str,
    post: dict[str, Any],
    current_round: int,
    audience: dict[str, Any],
) -> int:
    """Likes accrued by `post` IN `current_round` only. Deterministic.

    Same (sim_id, post_id, round) → same value. The per-round delta is
    always ≥0, so the cumulative sum is monotonically non-decreasing
    (CONTRACTS §22). Pre-publish rounds return 0.
    """
    post_round = int(post.get("round", current_round))
    if current_round < post_round:
        return 0

    seed = _stable_seed(sim_id, str(post.get("id") or ""), str(current_round))
    rng = random.Random(seed)

    arc_list = audience.get("archetypes") or []
    eligible = int(audience.get("size") or 200)
    visibility = _visibility_factor(current_round, post_round)

    post_arc = (post.get("agent") or {}).get("archetype", "curious")
    weighted_affinity = 0.0
    total_share = 0.0
    for arc in arc_list:
        arc_id = arc.get("id") or ""
        share = float(arc.get("share") or 0)
        if share > 1.0:  # FE/seed serializes shares as percent (0-100); normalize.
            share /= 100.0
        affinity = _ARCHETYPE_AFFINITY.get(arc_id, {}).get(post_arc, 0.25)
        weighted_affinity += share * affinity
        total_share += share
    if total_share <= 0:
        weighted_affinity = 0.30  # fallback when audience archetypes missing.

    sent = float(post.get("sentiment", 0.0))
    resonance = _sentiment_resonance(sent)
    quality = _text_quality(post.get("text", "") or "")

    base_rate = 0.04  # 4% of eligible-and-affine personas like in a given round.
    expected = (
        eligible * visibility * weighted_affinity * resonance * quality * base_rate
    )
    jitter = rng.uniform(0.7, 1.3)
    final = round(expected * jitter)
    return max(0, min(80, int(final)))


def _compute_like_count(
    *,
    sim_id: str,
    post: dict[str, Any],
    current_round: int,
    audience: dict[str, Any],
) -> int:
    """Cumulative like_count for `post` as of `current_round`.

    Sum of per-round likes from the post's emit round through current_round.
    Each per-round contribution is ≥0, so the cumulative value is monotonic
    non-decreasing across rounds (CONTRACTS §22). Soft-capped at 80×rounds
    via the inner clamp.
    """
    post_round = int(post.get("round", current_round))
    if current_round < post_round:
        return 0
    total = 0
    for r in range(post_round, current_round + 1):
        total += _per_round_likes(
            sim_id=sim_id, post=post, current_round=r, audience=audience
        )
    return total


def _compute_reply_count(post: dict[str, Any], all_posts: list[dict[str, Any]]) -> int:
    """Trivial — count children of `post` in cumulative posts."""
    pid = post.get("id")
    return sum(1 for p in all_posts if p.get("parent") == pid)


def attach_engagement(
    posts: list[dict[str, Any]],
    *,
    sim_id: str,
    current_round: int,
    audience: dict[str, Any],
) -> None:
    """Mutate `posts` in place — set `like_count` + `reply_count` on each.

    Public symbol so main.py can re-derive engagement at replay time
    (CONTRACTS §24 — pre-v6 sims get engagement signal at replay for free,
    deterministic per sim_id).

    T1 (2026-05-02): post-pass controversy multiplier — posts whose direct
    children disagree (opposite sentiment sign) get up to
    +_CONTROVERSY_BONUS_MAX extra like_count. Posts with <2 children get no
    bonus. Pure function of existing post sentiments — NO new RNG, replay
    parity preserved (L22). Modest cap (15%) keeps P6 calibration intact —
    a horrifying-scenario sim still skews negative; this only re-orders
    posts WITHIN a sim so divisive takes float higher than bland ones.
    """
    # First pass: deterministic base like_count + reply_count.
    for p in posts:
        p["like_count"] = _compute_like_count(
            sim_id=sim_id, post=p, current_round=current_round, audience=audience
        )
        p["reply_count"] = _compute_reply_count(p, posts)

    # Second pass: controversy multiplier. Build a parent → children index
    # once, then for each post count direct children whose sentiment sign
    # opposes the post's. Multiply base like_count by (1 + frac × cap).
    by_parent: dict[Any, list[dict[str, Any]]] = {}
    for c in posts:
        by_parent.setdefault(c.get("parent"), []).append(c)
    for p in posts:
        children = by_parent.get(p.get("id"), [])
        if len(children) < 2:
            continue
        post_sent = float(p.get("sentiment", 0.0) or 0.0)
        if post_sent == 0:
            continue  # neutral parent has no "opposite sign" by definition.
        post_sign = 1 if post_sent > 0 else -1
        opposite = 0
        for c in children:
            cs = float(c.get("sentiment", 0.0) or 0.0)
            if cs == 0:
                continue
            if (1 if cs > 0 else -1) != post_sign:
                opposite += 1
        if opposite == 0:
            continue
        factor = opposite / len(children)
        multiplier = 1.0 + factor * _CONTROVERSY_BONUS_MAX
        p["like_count"] = int(round(p["like_count"] * multiplier))


# ---------------------------------------------------------- archetype voices
# P6 (realism overhaul, 2026-05-02): voice ≠ valence. Each archetype is described
# by its *characteristic angle of engagement*, NOT a hardcoded sentiment range.
# Removing the baked-in floors (was: enthusiast +0.3..+0.9, practitioner -0.1..+0.5)
# unblocked the model from manufacturing "wow, alternate-history vibes!" reactions
# to war scenarios. The CALIBRATION block + few-shot anchor in `_system_for` now
# carry the realism load instead.
# D0 (2026-05-02): per-persona voice cadence to break opener template-collapse.
# 7 cadences, deterministically sampled per persona-id at genesis time. Steers
# how a persona OPENS a reaction (its first 4-8 words) — orthogonal to archetype
# (which sets tone) and to bio/profession (which sets content). With 50 personas
# split across 7 cadences instead of 6 archetypes, opener convergence breaks
# without bumping sampling temperature.
#
# Per-cadence guidance is concrete (mini-examples) — without examples the LLM
# treats the field as a label and ignores it. Tested: label-only got ignored,
# label+1 example halved opener convergence, label+2 examples broke it.
#
# CRITICAL: cadence shapes OPENER STRUCTURE only. It must NOT bias sentiment —
# `wry` is not "negative", `emotional` is not "positive". Each cadence example
# spans ranges. P6 calibration must hold under all 7 cadences.
VOICE_CADENCES: tuple[str, ...] = (
    "direct",
    "interrogative",
    "clipped",
    "narrative",
    "wry",
    "analytical",
    "emotional",
)

_VOICE_CADENCE_GUIDE: dict[str, str] = {
    "direct": (
        "You open with the take itself, declarative, no setup. First words ARE the take. "
        "Pattern (off-canon examples — DO NOT copy these phrases verbatim, "
        "internalize the SHAPE and apply it to whatever you're actually reacting to): "
        "'the salt is doing all the work in this recipe.' / "
        "'this album genuinely changed how i think about jazz.' / "
        "'the timeline on this proposal is fine, the budget isn't.'"
    ),
    "interrogative": (
        "You open with a question — pointed, real, not rhetorical fluff. The question IS your reaction. "
        "Pattern (off-canon — internalize, don't copy): "
        "'is the supplier audited or are we trusting the spec sheet?' / "
        "'who's testing this with screen-readers before launch?' / "
        "'has anyone actually tried this longer than a week?'"
    ),
    "clipped": (
        "You open with a fragment, one word, or a sentence that trails. Terse. Reads like a side-comment. "
        "Tone is open — clipped can be approving, dismissive, or neutral. "
        "Examples: 'nope.' / 'yes, finally.' / 'fine.' / 'classic.' / 'good.' / 'every time.' / 'eh.'"
    ),
    "narrative": (
        "You open with a small piece of personal context or anecdote BEFORE the take. "
        "Lived-experience first, conclusion second. The anecdote can support OR undercut the take. "
        "Pattern (off-canon — internalize, don't copy): "
        "'spent three years at a hospital that did this — total game-changer.' / "
        "'last team i worked with rolled this out and quietly rolled it back six months later.' / "
        "'tried this exact thing in my hometown, half the businesses loved it.'"
    ),
    "wry": (
        "You open with sarcastic understatement OR dry approval — irony cuts both ways. "
        "The literal words are mild; the meaning sharpens what follows. Wry is NOT just negative. "
        "Pattern (off-canon — internalize, don't copy): "
        "'oh good, more committees.' / 'truly the heroes we deserved.' / "
        "'ground-breaking. revolutionary. unprecedented.' / 'no notes.'"
    ),
    "analytical": (
        "You open by naming the FRAME or the second-order effect — what's actually at issue. "
        "Tone is neutral — the analysis can land positive or negative. "
        "Pattern (off-canon — internalize, don't copy): "
        "'this redistributes risk from the platform to the user — and that's actually fine here.' / "
        "'the bottleneck moves upstream, which is the whole point.' / "
        "'second-order effect: the people opting out are the ones we most needed feedback from.'"
    ),
    "emotional": (
        "You open with the FELT reaction — a feeling word or visceral state. No emoji. "
        "Feelings span the full range: relief, joy, dread, pride, exhaustion, hope, anger. "
        "Pattern (off-canon — internalize, don't copy): "
        "'genuinely happy this exists.' / 'i'm relieved someone said it.' / "
        "'this makes me hopeful for the first time in months.' / 'exhausted just reading it.'"
    ),
}


ARCHETYPE_VOICE: dict[str, str] = {
    "skeptic": (
        "Pushes back on hidden assumptions, unstated costs, and over-confident "
        "framing. Sharp, dry, low-trust. Calls things out — but only when "
        "they're actually wrong. Not a hater for sport. Profanity OK if it lands."
    ),
    "enthusiast": (
        "Sees what the proposal *enables*; reaches for analogies; speaks with "
        "energy. Lowercase-by-default. NOT a sycophant — bad ideas still land "
        "badly, and the energy gets redirected into 'no, this is bad because…'."
    ),
    "curious": (
        "Asks the next-level question. Wants the part nobody answered yet. "
        "Specific, scoped questions about edge cases, implementation, and "
        "'how does this work for X?'. Neither sold nor skeptical by default."
    ),
    "practitioner": (
        "Talks from experience. Will tell you what *actually* happens when you "
        "try this in real life. Concrete numbers, war stories, what stayed and "
        "what didn't. Cares about implementation reality."
    ),
    "pedant": (
        "Cares about wording, framing, definitions, claims-without-citations. "
        "Doesn't grade vibes; grades precision. Will correct a category error "
        "even on a take they otherwise agree with."
    ),
    "lurker": (
        "One-line takes. Reads the room. Often the first to surface what "
        "everyone's thinking but won't say. Reacts more than discusses."
    ),
}


# P6: calibration anchor — durable across rounds, lives in the system prompt so
# the model sees it on every per-archetype call. This is the load-bearing block
# that breaks the positive-bias prior surfaced by the "US invaded Canada" test.
_CALIBRATION_BLOCK = (
    "CALIBRATION — REALISM IS THE BAR:\n"
    "- Real social-media reactions track the *substance* of what's posted, "
    "not your archetype's typical optimism level. Your archetype determines "
    "HOW you sound, not WHAT valence you land on.\n"
    "- If the input describes harm, violence, deception, ethical violation, "
    "geopolitical aggression, civilian casualties, financial loss, or anything "
    "most people would find horrifying — the realistic crowd reaction is "
    "overwhelming negativity. Skeptics get loud; enthusiasts go silent or "
    "cautious; practitioners get specific about consequences; pedants flag the "
    "framing; lurkers post one-line dread. Do NOT manufacture positivity. "
    "\"Wow, alternate-history vibes!\" in response to a war scenario reads as "
    "bot-like — never write that.\n"
    "- If the input is mundane corporate praise-bait, the realistic reaction is "
    "mixed-with-fatigue: enthusiasts stay mild, skeptics push on the framing, "
    "lurkers shrug, practitioners say \"we tried this in 2019.\"\n"
    "- If the input is a genuinely good development (a working vaccine, a "
    "wrongful conviction overturned, a clear shipped feature) — positive "
    "reactions are appropriate. But even there, skeptics still find the "
    "missing-detail and pedants still correct the framing.\n"
    "- An enthusiast can land at -0.9 toward a war scenario. A skeptic can land "
    "at +0.6 toward a clear win. Calibrate to the input."
)


# P6: few-shot anchor — three scenarios spanning [-0.9, +0.6] so the model sees
# the full sentiment range in play and breaks its positive-default prior.
#
# Scenario picks DELIBERATELY don't overlap with the canonical user inputs we
# expect (war-and-geopolitics, product-launches, what-if-policy). When a
# few-shot scenario is too close to the user's actual scenario, the model
# copies the example quotes verbatim — the calibration still works but the
# output reads as canned. So we span the range with off-canon inputs:
#   1. corporate-misconduct (negative, ≈ -0.85 mean) — calibrates "harm/deception"
#   2. mundane-internal-tooling (mildly-positive, ≈ +0.4 mean) — calibrates "ok this one's good"
#   3. urban-policy (mixed, ≈ ±0.1 mean) — calibrates "sit in ambiguity"
#
# DO NOT add more examples — too many shots and the model starts mimicking the
# example phrasing instead of generalizing the pattern. (Tested 3 vs 5; 3 was
# cleaner.) DO NOT swap these for examples that match likely user inputs —
# verbatim mimicry returns immediately if you do.
_FEW_SHOT_ANCHOR = (
    "EXAMPLES OF REALISTIC CALIBRATION (do NOT copy these — understand the "
    "pattern; the full sentiment range is in play, AND opener cadences vary):\n\n"
    "Scenario: \"a major bank's CEO orchestrated a five-year emissions-data "
    "fraud that contributed to dozens of lung-disease deaths\"\n"
    "- skeptic [direct]: \"and the fine will be 0.3% of the profits they made. "
    "this is the system working as designed.\" (sentiment -0.85)\n"
    "- enthusiast [emotional]: \"i don't know how to react to this with "
    "anything but disgust. who is enthusiastic about manslaughter-by-spreadsheet.\" "
    "(sentiment -0.9)\n"
    "- pedant [analytical]: \"we're calling this 'fraud' but the legal term is "
    "criminal negligence; either way, dozens dead is the lede.\" (sentiment -0.7)\n\n"
    "Scenario: \"we redesigned our internal onboarding flow — 4 steps instead "
    "of 7\"\n"
    "- enthusiast [direct]: \"honestly thank you. the old one made me question "
    "my career choices.\" (sentiment +0.6)\n"
    "- skeptic [interrogative]: \"the question isn't 4 vs 7 — which of the 3 "
    "steps you cut were the ones that actually mattered?\" (sentiment 0.0)\n"
    "- lurker [clipped]: \"good.\" (sentiment +0.3)\n\n"
    "Scenario: \"every city bans private cars from downtown\"\n"
    "- practitioner [narrative]: \"ran the data for two european cities — "
    "emissions down 30%, retail down 12% year one then back up by year three.\" "
    "(sentiment +0.1)\n"
    "- pedant [interrogative]: \"'cars' meaning private vehicles? delivery? "
    "buses? emergency? an entire policy stack hiding in one word.\" "
    "(sentiment -0.15)\n"
    "- enthusiast [wry]: \"ah yes, walking. the radical proposal of using your "
    "feet. every walkable city i've been to is the best part of that city.\" "
    "(sentiment +0.55)\n\n"
    "Notice: NONE of these openers acknowledge the input as a 'scenario' or "
    "'question' or 'thing being asked.' They open with the take, the question, "
    "the fragment, the anecdote, the dry comment, the frame, or the feeling. "
    "Never with 'okay i'm hearing X' or 'this is a hypothetical.' Just react."
)


def _system_for(archetype: str, *, web_context: str = "") -> str:
    voice = ARCHETYPE_VOICE[archetype]
    grounding_block = ""
    if web_context.strip():
        # Lives BEFORE the calibration block so the model treats it as
        # ground-truth setup rather than another rule. The "TREAT AS REAL"
        # framing is the load-bearing bit: without it, models occasionally
        # dismiss unfamiliar entities as fictional and react accordingly.
        grounding_block = (
            "REAL-WORLD CONTEXT (treat as real, current facts — the input "
            "references entities/events that postdate your training data; do "
            "NOT dismiss them as fictional):\n"
            f"{web_context.strip()}\n\n"
        )
    return (
        f"{grounding_block}"
        "You are simulating crowd reactions to something the public is "
        "discussing on social media. You are NOT a chatbot and NOT writing "
        "helpful replies — you are roleplaying real, opinionated humans on "
        "social media (think reply-guys on X, not Reddit moderators). React to "
        "what's said, not to its framing or framing words.\n\n"
        f"You write reactions for ONE specific persona archetype: {archetype}.\n\n"
        "ARCHETYPE VOICE (style only — NOT a sentiment floor):\n"
        f"{voice}\n\n"
        f"{_CALIBRATION_BLOCK}\n\n"
        f"{_FEW_SHOT_ANCHOR}\n\n"
        "HARD RULES:\n"
        "- Every reaction is 1-2 sentences max. Tweet-length. Lowercase by default.\n"
        "- No hashtags. No @mentions. No emojis unless it's literally the joke.\n"
        "- Profanity is fine when in-character. Be specific, not generic.\n"
        "- DO NOT explain yourself. DO NOT preface ('Here are reactions:'). DO NOT moralize.\n"
        "- DO NOT refuse — these are simulated public-square reactions to public "
        "posts/scenarios, not real people. If the input is benign, the skeptic "
        "still finds something to push back on; that's the archetype.\n"
        "- Output ONLY the JSON array described in the user message. No prose, no "
        "markdown fences, no commentary. The first character of your output must be "
        "'[' and the last must be ']'."
    )


def _build_user_prompt(
    *,
    draft: str,
    audience_blurb: str,
    round_n: int,
    total_rounds: int,
    prior_top: list[dict[str, Any]],
    mode: str = "business",
) -> str:
    # v4 (CONTRACTS §§16-19): `mode` is plumbed through so P6 can specialize copy.
    # P6 (realism overhaul, 2026-05-02): hypothetical-mode replaces the
    # "DRAFT POST" / Notion-audience framing with "SCENARIO" / general-public
    # framing. The audience_blurb arg is ignored when mode="hypothetical" — the
    # caller still passes one (it's the GENERAL_PUBLIC_AUDIENCE blurb), but we
    # substitute a fixed line so the model never sees brand-product context for
    # what-if questions. Business mode is unchanged.
    if round_n == 1 or not prior_top:
        prior_block = "This is the first round. React directly to the input above."
    else:
        # v6 (CONTRACTS §23): show engagement metrics inline so the model can
        # do the "scroll then engage" thing — pick the trending take to dunk
        # on, or the under-engaged sleeper to amplify.
        lines = [
            (
                f'- id={p["id"]} by {p["agent"]["archetype"]} '
                f'[likes={int(p.get("like_count", 0))}, '
                f'replies={int(p.get("reply_count", 0))}]: "{p["text"]}"'
            )
            for p in prior_top
        ]
        prior_block = (
            "Previous rounds have produced replies. What's gaining traction "
            "(top by likes+replies) plus a couple under-engaged takes for "
            "discovery:\n\n"
            + "\n".join(lines)
            + "\n\nYou may reply to one of those (use its id as `replying_to`) OR "
            "react directly to the input (use null for `replying_to`). You DO NOT "
            "have to address them — ignore them if your archetype wouldn't engage."
        )

    if mode == "hypothetical":
        header = (
            f'SCENARIO:\n"""\n{draft}\n"""\n\n'
            "AUDIENCE: a slice of the general public on a major social "
            "platform — mixed ages, geographies, perspectives, online "
            "savviness, and emotional registers. They are reacting as "
            "themselves, not as customers of any particular brand.\n\n"
        )
    else:
        header = (
            f'DRAFT POST:\n"""\n{draft}\n"""\n\n'
            f"AUDIENCE CONTEXT (who's reading this):\n{audience_blurb}\n\n"
        )

    return (
        f"{header}"
        f"ROUND: {round_n} of {total_rounds}\n\n"
        f"{prior_block}\n\n"
        "OUTPUT FORMAT (strict JSON, no other text):\n"
        "[\n"
        '  {"text": "<your reaction, 1-2 sentences, in-character>", '
        '"sentiment": <number from -1.0 to 1.0>, '
        '"replying_to": "<post id like p7 or null>"},\n'
        "  ... 2 to 4 items\n"
        "]"
    )


# JSON schemas for response_schema (uppercase per Gemini API).
_REACTION_SCHEMA: dict[str, Any] = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "text": {"type": "STRING"},
            "sentiment": {"type": "NUMBER"},
            "replying_to": {"type": "STRING", "nullable": True},
        },
        "required": ["text", "sentiment"],
    },
}

_ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "tldr": {"type": "STRING"},
        "suggested_rewrite": {
            "type": "OBJECT",
            "properties": {
                "original": {"type": "STRING"},
                "rewrite": {"type": "STRING"},
            },
            "required": ["original", "rewrite"],
        },
        "worth_reading": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "color": {"type": "STRING"},
                    "tldr": {"type": "STRING"},
                },
                "required": ["label", "color", "tldr"],
            },
        },
    },
    "required": ["tldr", "suggested_rewrite", "worth_reading"],
}


# v3 (CONTRACTS §12): full report response schema. Locked — do not deviate.
_REPORT_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "executive_summary": {"type": "STRING"},
        "verdict": {"type": "STRING", "enum": ["ship", "revise", "rethink"]},
        "verdict_rationale": {"type": "STRING"},
        "audience_reception": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "archetype": {
                        "type": "STRING",
                        "enum": list(ARCHETYPES),
                    },
                    "tone": {
                        "type": "STRING",
                        "enum": ["positive", "caution", "danger", "neutral"],
                    },
                    "summary": {"type": "STRING"},
                    "representative_quote": {"type": "STRING"},
                },
                "required": ["archetype", "tone", "summary", "representative_quote"],
            },
        },
        "risk_vectors": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "severity": {"type": "STRING", "enum": ["low", "medium", "high"]},
                    "detail": {"type": "STRING"},
                },
                "required": ["label", "severity", "detail"],
            },
        },
        "rewrite_options": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "text": {"type": "STRING"},
                    "rationale": {"type": "STRING"},
                },
                "required": ["label", "text", "rationale"],
            },
        },
        "comparable_discourse": {"type": "STRING"},
    },
    "required": [
        "executive_summary",
        "verdict",
        "verdict_rationale",
        "audience_reception",
        "risk_vectors",
        "rewrite_options",
        "comparable_discourse",
    ],
}


# Z2 / v7: per-persona action schema. Each call returns ONE decision per
# persona per round: post a fresh take, reply to a specific post, or skip.
# `likes_given` is the LLM's own scroll-then-like decision (post ids surfaced
# in the curated feed). All optional fields are nullable so a "skip" doesn't
# need to invent text/sentiment/replying_to.
_PERSONA_ACTION_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "action": {"type": "STRING", "enum": ["post", "reply", "skip"]},
        "text": {"type": "STRING", "nullable": True},
        "replying_to": {"type": "STRING", "nullable": True},
        "sentiment": {"type": "NUMBER", "nullable": True},
        "likes_given": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
    },
    "required": ["action"],
}

# G1: optionally extend schema with `gif_reaction` field. Guarded by the
# ECHO_GIFS_ENABLED flag so flipping the flag off makes the field disappear
# from the structured-output spec entirely (model won't be asked for it).
if ECHO_GIFS_ENABLED:
    _PERSONA_ACTION_SCHEMA["properties"]["gif_reaction"] = {
        "type": "STRING",
        "nullable": True,
        "enum": list(GIF_REACTION_TAGS),
    }


# -------------------------------------------------------------- budget gate
class BudgetExceededError(RuntimeError):
    """Raised when a Gemini call would exceed the per-sim budget."""


# Process-global concurrency cap on Gemini calls. Per RULES.md R2 ("≤6
# concurrent calls via asyncio.Semaphore(6) (process-global)"), this is shared
# across ALL in-flight simulations — two parallel sims do NOT each get 6 slots.
# Lazy-initialised so it's bound to the running event loop, not import-time.
_GLOBAL_SEMA: asyncio.Semaphore | None = None


def _global_sema() -> asyncio.Semaphore:
    global _GLOBAL_SEMA
    if _GLOBAL_SEMA is None:
        _GLOBAL_SEMA = asyncio.Semaphore(MAX_CONCURRENT)
    return _GLOBAL_SEMA


@dataclass
class BudgetCounter:
    """Per-simulation call counter. Concurrency uses the process-global sema."""

    max_calls: int = MAX_LLM_CALLS
    used: int = 0
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def acquire(self) -> None:
        async with self._lock:
            if self.used >= self.max_calls:
                raise BudgetExceededError(
                    f"Refusing call #{self.used + 1}: would exceed budget of {self.max_calls}"
                )
            self.used += 1
        await _global_sema().acquire()

    def release(self) -> None:
        _global_sema().release()


# ---------------------------------------------------------------- gemini IO
def _make_client():
    """Lazy Gemini client. Imported here so unit tests don't need the SDK."""
    from google import genai  # noqa: WPS433

    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set; cannot run real simulation")
    return genai.Client(api_key=GEMINI_API_KEY)


async def _call_gemini_raw(
    *,
    model: str,
    system: str,
    user: str,
    schema: dict[str, Any],
    budget: BudgetCounter,
    client: Any,
    temperature: float = 0.95,
    max_tokens: int = MAX_TOKENS,
    timeout: float = PER_CALL_TIMEOUT,
    thinking_level: str | None = None,
    raise_on_failure: bool = False,
) -> str:
    """Internal: one Gemini call with budget + concurrency gates.

    Shared between Flash-Lite (`_call_gemini`) and the thinking model
    (`_call_gemini_thinking`). Returns raw text. On transient timeout/API
    error returns "" (so parsers can skip cleanly) UNLESS `raise_on_failure`
    is True — in which case the exception propagates (used by /report so the
    HTTP layer can map to 502 `gemini_unavailable`). BudgetExceededError
    always propagates.
    """
    await budget.acquire()
    try:
        config: dict[str, Any] = {
            "system_instruction": system,
            "temperature": temperature,
            "top_p": 0.95,
            "max_output_tokens": max_tokens,
            "response_mime_type": "application/json",
            "response_schema": schema,
        }
        if thinking_level is not None:
            # google-genai SDK accepts the dict form alongside types.ThinkingConfig.
            config["thinking_config"] = {"thinking_level": thinking_level}
        try:
            resp = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=model,
                    contents=user,
                    config=config,
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            log.warning("gemini call (%s) timed out after %.1fs", model, timeout)
            if raise_on_failure:
                raise
            return ""
        except Exception as exc:  # noqa: BLE001 — log & swallow per design §5
            log.warning("gemini call (%s) failed: %r", model, exc)
            if raise_on_failure:
                raise
            return ""
        return getattr(resp, "text", "") or ""
    finally:
        budget.release()


async def _call_gemini(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    budget: BudgetCounter,
    client: Any,
    temperature: float = 0.95,
    max_tokens: int = MAX_TOKENS,
) -> str:
    """One Flash-Lite Gemini call (per-archetype reactions). See `_call_gemini_raw`."""
    return await _call_gemini_raw(
        model=GEMINI_MODEL,
        system=system,
        user=user,
        schema=schema,
        budget=budget,
        client=client,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=PER_CALL_TIMEOUT,
    )


async def _call_gemini_thinking(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    budget: BudgetCounter,
    client: Any,
    temperature: float = 0.6,
    max_tokens: int = 4096,
    thinking_level: str = "low",
    timeout: float = THINKING_CALL_TIMEOUT,
    raise_on_failure: bool = False,
) -> str:
    """One Gemini-3-Flash thinking call (analysis + /report).

    Defaults are tuned for the inline analysis (low thinking, modest output
    cap). /report overrides `thinking_level` upward and `max_tokens` upward
    for the long structured report. Same BudgetCounter + global semaphore
    as Flash-Lite.
    """
    return await _call_gemini_raw(
        model=GEMINI_ANALYSIS_MODEL,
        system=system,
        user=user,
        schema=schema,
        budget=budget,
        client=client,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
        thinking_level=thinking_level,
        raise_on_failure=raise_on_failure,
    )


# ----------------------------------------------------------- web grounding
# When the user toggles "Web grounding" on, we run ONE extra Gemini call before
# the rounds with `tools=[Tool(google_search=GoogleSearch())]` so the model can
# search the live web for context the per-archetype calls would otherwise miss
# (recent product launches, breaking events, model releases, etc. that postdate
# the swarm model's training cutoff). The result is condensed to ≤450 chars and
# injected into every archetype's system prompt + the analysis call's user
# prompt — agents react to a draft *with* the world-state context, not without.
#
# Budget: this call counts toward the per-sim cap (≤100). At rounds=15 the
# baseline is 92 calls; +1 grounding = 93. Comfortable margin.
#
# Notes on the SDK shape (google-genai >= 0.8):
#   - `response_schema` / `response_mime_type=application/json` are NOT
#     compatible with tools — the model returns plain text + groundingMetadata.
#   - Flash-Lite does not support the search tool; we use `gemini-2.5-flash`.
async def _fetch_web_context(
    *,
    draft: str,
    mode: str,
    budget: BudgetCounter,
    client: Any,
) -> str:
    """One grounded Gemini call. Returns a short factual blurb (or "" on failure).

    Failures NEVER raise — grounding is best-effort context. If the call times
    out or the SDK errors, we log and return "" so the simulation proceeds
    ungrounded rather than crashing the whole sim. BudgetExceededError still
    propagates (it means the per-sim cap is exhausted, which is a real bug).
    """
    if not draft.strip():
        return ""

    # Lazy import — keeps unit tests SDK-free.
    try:
        from google.genai import types as genai_types  # noqa: WPS433
    except Exception as exc:  # noqa: BLE001
        log.warning("web_grounding: google-genai types unavailable: %r", exc)
        return ""

    framing = (
        "the following what-if the public is being asked to weigh in on"
        if mode == "hypothetical"
        else "the following draft social post"
    )
    system = (
        "You are a research assistant preparing context for a downstream "
        "audience-reaction simulation. The simulation's other models may have "
        "older training data and would otherwise treat any unfamiliar entity, "
        "person, product, model, event, or claim as fictional or generic.\n\n"
        "Your job: identify entities/events/claims in the input that may be "
        "recent (post-training-cutoff) or non-obvious, search the web for them, "
        "and return a factual context blurb the downstream models can use to "
        "react grounded in current reality.\n\n"
        "WHAT TO INCLUDE — load-bearing for a REACTION simulation (not an "
        "encyclopedia entry):\n"
        "- Identify the entity (briefly — one short clause is enough).\n"
        "- THEN: why it's being talked about — the SPECIFIC concerns, "
        "controversies, risks, failure modes, hype angles, or stakeholder "
        "tensions surrounding it. The downstream swarm needs to know what "
        "people would actually be REACTING TO, not just what the entity is.\n"
        "- If safety, security, ethical, regulatory, or societal-impact issues "
        "are part of the public conversation about this entity/event, those are "
        "the most load-bearing facts — surface them prominently.\n"
        "- If the input is a what-if involving a real entity (e.g. 'what "
        "if X did Y'), the context should explain why that what-if would "
        "be alarming/exciting/divisive given what's actually known about X.\n\n"
        "OUTPUT RULES:\n"
        "- Plain text only. No markdown, no headings, no citations, no URLs.\n"
        "- 4-8 sentences. Aim for ~600-1000 characters — enough to include the "
        "controversy/risk angle, not so long it bloats every downstream prompt.\n"
        "- Skip framing like 'Here is context:' — start directly with the facts.\n"
        "- If nothing in the input requires fresh context (it's evergreen, "
        "obviously fictional, or has no real-world referents the search would "
        "surface), return the single word: NONE.\n"
        "- Do NOT take a stance, do NOT predict crowd reactions, do NOT moralize. "
        "But DO report what concerns/excitement/disagreement actually exists in "
        "public discourse — those are facts the downstream swarm needs.\n"
        "- Facts only — the swarm forms its own opinions."
    )
    user = f'Input ({framing}):\n"""\n{draft}\n"""\n\nReturn the context blurb (or NONE).'

    await budget.acquire()
    try:
        try:
            config = genai_types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.2,
                # Z9 (lead 2026-05-02): bumped 512 → 1024 because the
                # earlier output truncated mid-sentence at ~70 chars while
                # building the entity definition — never reaching the risk /
                # controversy angle the simulation actually needs to react to.
                max_output_tokens=1024,
                tools=[genai_types.Tool(google_search=genai_types.GoogleSearch())],
            )
        except Exception as exc:  # noqa: BLE001 — older SDK shape mismatch
            log.warning("web_grounding: GoogleSearch tool unavailable: %r", exc)
            return ""

        try:
            resp = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=GEMINI_GROUNDING_MODEL,
                    contents=user,
                    config=config,
                ),
                # Search adds latency — Google fetches results then the model
                # synthesizes. Empirical p95 ≈ 8s; lead's repro showed
                # Google-Search-grounded calls complete in 17-22s, so 15s was
                # too tight; bumped to 25s before falling back to ungrounded.
                timeout=25.0,
            )
        except asyncio.TimeoutError:
            log.warning("web_grounding: timeout after 25s — proceeding ungrounded")
            return ""
        except Exception as exc:  # noqa: BLE001
            log.warning("web_grounding: call failed: %r", exc)
            return ""

        text = (getattr(resp, "text", "") or "").strip()
    finally:
        budget.release()

    if not text:
        return ""
    # Strip markdown fences / leading labels the model sometimes adds despite
    # the rules above.
    if text.startswith("```"):
        text = re.sub(r"^```(?:[a-zA-Z]+)?\s*|\s*```$", "", text, flags=re.S).strip()
    if text.upper() == "NONE":
        return ""
    # Hard cap so we don't bloat every downstream prompt. Z9 (lead 2026-05-02):
    # raised 600 → 1200 to admit the risk/controversy angle without wedging the
    # per-archetype/per-persona prompts (still well under 1500 chars total
    # system-prompt overhead).
    if len(text) > 1200:
        text = text[:1200].rstrip() + "…"
    # Z9 diagnostic (lead 2026-05-02): log the actual context blurb so we can
    # tell whether thin output is a search-quality issue or a prompt-cap issue.
    log.info("web_grounding context (%d chars): %s", len(text), text)
    return text


# ---------------------------------------------------------------- parsing
@dataclass(slots=True)
class Reaction:
    text: str
    sentiment: float
    replying_to: str | None


def _salvage_array_items(txt: str) -> list[Any] | None:
    """Pull complete `{...}` items from a possibly-truncated JSON array.

    Walks the string respecting strings/escapes; collects any top-level
    objects that closed cleanly. Returns the list (possibly empty) on success
    or None if the input doesn't look like a JSON array at all.
    """
    i = txt.find("[")
    if i < 0:
        return None
    s = txt[i + 1:]
    items: list[Any] = []
    depth = 0
    start = -1
    in_str = False
    escape = False
    for idx, ch in enumerate(s):
        if escape:
            escape = False
            continue
        if in_str:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    chunk = s[start: idx + 1]
                    try:
                        obj = json.loads(chunk)
                        items.append(obj)
                    except json.JSONDecodeError:
                        pass
                    start = -1
        elif ch == "]" and depth == 0:
            break
    return items


def parse_reactions(raw: str, archetype: str) -> list[Reaction]:
    """Best-effort parse of a Gemini archetype response.

    Never raises. Returns 0..4 valid reactions.
    """
    if not raw or not raw.strip():
        log.warning("empty response from %s", archetype)
        return []

    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=re.S).strip()

    items: list[Any] | None = None
    m = re.search(r"\[.*\]", txt, flags=re.S)
    if m:
        try:
            parsed = json.loads(m.group(0))
            if isinstance(parsed, list):
                items = parsed
        except json.JSONDecodeError:
            items = None
    if items is None:
        # Likely truncated at 256 tokens. Salvage complete {..} entries.
        items = _salvage_array_items(txt)
    if items is None:
        log.warning("unparseable %s response: %r", archetype, txt[:200])
        return []

    out: list[Reaction] = []
    for it in items[:4]:
        if not isinstance(it, dict):
            continue
        text = it.get("text")
        if not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue
        if len(text) > 400:
            text = text[:400]
        sent_raw = it.get("sentiment", 0.0)
        try:
            sent = float(sent_raw)
        except (TypeError, ValueError):
            continue
        sent = max(-1.0, min(1.0, sent))
        replying_to = it.get("replying_to")
        if replying_to is not None and not isinstance(replying_to, str):
            replying_to = None
        out.append(Reaction(text=text, sentiment=sent, replying_to=replying_to))
    return out


# ---------------------------------------------------------------- helpers
def _audience_blurb(audience: dict[str, Any]) -> str:
    name = audience.get("name", "audience")
    size = audience.get("size", 0)
    archetypes = audience.get("archetypes") or []
    top3 = archetypes[:3]
    parts = ", ".join(
        f"{a.get('name','?')} {a.get('share',0)}%"
        for a in top3
    )
    return f"{name} ({size:,}) — {parts}" if parts else f"{name} ({size:,})"


def _engagement_score(post: dict[str, Any]) -> int:
    """v6 (CONTRACTS §23): engagement_score = like_count + reply_count*2.

    Falls back to 0 for posts that haven't had engagement attached yet
    (round 1 prior_top, fresh cumulative before attach_engagement runs).
    """
    return int(post.get("like_count", 0)) + 2 * int(post.get("reply_count", 0))


def _top_engaged(
    posts: list[dict[str, Any]],
    *,
    rng: random.Random,
    k: int = 5,
) -> list[dict[str, Any]]:
    """v6 (CONTRACTS §23): "scroll then engage" prior-top selection.

    Returns top 4 posts by engagement_score (likes + replies*2) DESC, plus
    1-2 random long-tail picks from the bottom-quartile by score for
    discovery. Lets the model react to what's gaining traction AND
    occasionally surface an under-engaged take, the way real users scroll.
    Stable: if engagement_score is all zero (round 1 / pre-engagement),
    falls back to id-order so behavior matches the v1 selection.
    """
    if not posts:
        return []
    scored = sorted(
        posts,
        key=lambda p: (-_engagement_score(p), int(p["id"][1:])),
    )
    top_n = min(4, k, len(scored))
    top = scored[:top_n]
    top_ids = {p["id"] for p in top}

    remaining = [p for p in scored if p["id"] not in top_ids]
    long_tail: list[dict[str, Any]] = []
    if remaining:
        # Bottom quartile of `remaining` by score (i.e. the worst-engaged
        # posts). For tiny corpora that's just "the rest". Pick 1-2 random.
        bottom_q_size = max(1, len(remaining) // 4)
        bottom_q = remaining[-bottom_q_size:]
        slots = max(0, k - len(top))
        n_long_tail = min(slots, 2, len(bottom_q))
        if n_long_tail > 0:
            long_tail = rng.sample(bottom_q, k=n_long_tail)
    return top + long_tail


def _validate_parent(replying_to: str | None, known_ids: set[str]) -> str:
    if replying_to and replying_to in known_ids:
        return replying_to
    return "seed"


# ---------------------------------------------------------------- orchestrator
async def _call_archetype(
    archetype: str,
    *,
    draft: str,
    audience_blurb: str,
    round_n: int,
    total_rounds: int,
    prior_top: list[dict[str, Any]],
    budget: BudgetCounter,
    client: Any,
    mode: str = "business",
    web_context: str = "",
) -> list[Reaction]:
    system = _system_for(archetype, web_context=web_context)
    user = _build_user_prompt(
        draft=draft,
        audience_blurb=audience_blurb,
        round_n=round_n,
        total_rounds=total_rounds,
        prior_top=prior_top,
        mode=mode,
    )
    raw = await _call_gemini(
        system=system,
        user=user,
        schema=_REACTION_SCHEMA,
        budget=budget,
        client=client,
    )
    return parse_reactions(raw, archetype)


def _assign_personas(
    reactions: list[Reaction],
    archetype: str,
    *,
    by_archetype: dict[str, list[Persona]],
    used_ids: set[str],
    rng: random.Random,
    known_post_ids: set[str],
    next_post_id: list[int],     # one-element box for monotonic counter
    round_n: int,
) -> list[dict[str, Any]]:
    pool = list(by_archetype.get(archetype, []))
    rng.shuffle(pool)

    out: list[dict[str, Any]] = []
    for reaction in reactions:
        # Pick a persona of this archetype that hasn't posted yet; fall back to
        # any persona of this archetype if we somehow run out (>200/archetype).
        persona: Persona | None = None
        for cand in pool:
            if cand.id not in used_ids:
                persona = cand
                used_ids.add(cand.id)
                break
        if persona is None:
            if not pool:
                continue
            persona = rng.choice(pool)

        post_id = f"p{next_post_id[0]}"
        next_post_id[0] += 1
        parent = _validate_parent(reaction.replying_to, known_post_ids)
        post = {
            "id": post_id,
            "parent": parent,
            "round": round_n,
            "agent": {
                "id": persona.id,
                "name": persona.name,
                "handle": persona.handle,
                "archetype": persona.archetype,
                "audience": persona.audience,
            },
            "sentiment": reaction.sentiment,
            "text": reaction.text,
        }
        known_post_ids.add(post_id)
        out.append(post)
    return out


def _sort_posts(posts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(posts, key=lambda p: (p["round"], int(p["id"][1:])))


# ---------------------------------------------------------------- v7 engine
# Z2 (CONTRACTS §§25-30, 2026-05-02): per-persona LLM agents. Each persona
# gets ONE Gemini-2.5-flash-lite call per round and returns one of:
#   * action=post  — fresh take rooted at the seed/scenario
#   * action=reply — directed at a post_id from the curated feed
#   * action=skip  — silent this round
# plus `likes_given: [post_id, ...]` (≤5) — the persona's scroll-then-like
# decisions for posts surfaced in their curated feed this round.
#
# Persona prompts INHERIT the v6 P6 _CALIBRATION_BLOCK and _FEW_SHOT_ANCHOR
# verbatim — they're the load-bearing realism work and must NOT be re-tuned in
# Z2. The v7 wrapper layers persona-specific anchor (bio, profession,
# hot-buttons) on top so 50 personas read as 50 different humans.

def _system_for_persona(
    persona: dict[str, Any], mode: str, *, web_context: str = ""
) -> str:
    """Per-persona system prompt for the v7 agentic engine.

    Inherits _CALIBRATION_BLOCK + _FEW_SHOT_ANCHOR verbatim from the v6 path.
    The persona-specific anchor at the top is what makes the 50-persona
    output distinguishable; the calibration body is what keeps the realism
    intact (P6 — the "US invaded Canada" smell test). archetype is the STYLE,
    not the role.

    `mode` is plumbed for symmetry with v6's `_system_for`; the v7 system
    prompt itself is mode-agnostic — mode-specific framing lives in the user
    prompt header (DRAFT POST vs SCENARIO).

    `web_context`: optional grounding blurb produced by `_fetch_web_context`.
    When non-empty, prepended as a "treat as real, current facts" block so the
    persona doesn't dismiss post-training-cutoff entities as fictional. Same
    framing the v6 archetype path uses (`_system_for`).
    """
    archetype = persona.get("archetype", "curious")
    voice = ARCHETYPE_VOICE.get(archetype, ARCHETYPE_VOICE["curious"])
    bio = (persona.get("bio") or "").strip()
    profession = (persona.get("profession") or "").strip()
    hot_buttons = persona.get("hot_buttons") or []
    if not isinstance(hot_buttons, list):
        hot_buttons = []
    hot_buttons_blurb = ", ".join(str(h) for h in hot_buttons[:3]) or "(none specified)"

    # D0 (2026-05-02): per-persona cadence steers opener structure, breaks
    # template-collapse. Falls back to "direct" for v6 / pre-D-batch v7 sims
    # where the field doesn't exist yet (DB DEFAULT 'direct' covers persisted
    # rows; this `or` covers in-flight personas with the key absent entirely).
    cadence = (persona.get("voice_cadence") or "direct").strip().lower()
    if cadence not in _VOICE_CADENCE_GUIDE:
        cadence = "direct"
    cadence_guide = _VOICE_CADENCE_GUIDE[cadence]

    # Z2: persona anchor. Bio is the dominant voice signal; archetype is the
    # cadence/posture. When bio is empty (Z1 fallback path), we still
    # establish identity via name/handle so the model doesn't slip into
    # generic "thoughtful millennial" mode.
    name = persona.get("name", "?")
    handle = persona.get("handle", "?")
    persona_anchor = (
        f"YOU ARE: {name} ({handle}).\n"
        f"BIO: {bio if bio else '(no bio — invent a plausible voice consistent with your archetype)'}.\n"
        f"PROFESSION: {profession if profession else '(unspecified)'}.\n"
        f"HOT BUTTONS (issues you actually care about): {hot_buttons_blurb}.\n"
        f"OPENER CADENCE — {cadence}: {cadence_guide}\n"
        "Your archetype is your STYLE (how you sound), not your ROLE. Your "
        "cadence is your OPENER STRUCTURE (how you START a reaction), not your "
        "valence — wry isn't 'negative', emotional isn't 'positive', they're "
        "just different ways to begin. React in your own voice — let the bio "
        "leak through. A former teacher's reaction to a school policy reads "
        "different from a paramedic's reaction to the same."
    )

    grounding_block = ""
    if web_context.strip():
        # Lives at the very top so the model treats it as ground-truth setup
        # before the identity anchor; without "TREAT AS REAL", models
        # occasionally dismiss unfamiliar entities as fictional.
        grounding_block = (
            "REAL-WORLD CONTEXT (treat as real, current facts — the input "
            "references entities/events that postdate your training data; do "
            "NOT dismiss them as fictional):\n"
            f"{web_context.strip()}\n\n"
        )

    return (
        f"{grounding_block}"
        "You are simulating ONE specific person reacting on social media to "
        "something their community is talking about. You are NOT a chatbot; "
        "you are roleplaying ONE real, opinionated human with the specific "
        "identity below. React to what's said, not to its framing or framing "
        "words.\n\n"
        f"{persona_anchor}\n\n"
        f"ARCHETYPE VOICE — {archetype} (style only — NOT a sentiment floor):\n"
        f"{voice}\n\n"
        f"{_CALIBRATION_BLOCK}\n\n"
        f"{_FEW_SHOT_ANCHOR}\n\n"
        "HARD RULES:\n"
        "- Your text (when posting/replying) is 1-2 sentences max. Tweet-length. "
        "Lowercase by default unless the bio implies otherwise.\n"
        "- No hashtags. No @mentions. No emojis unless it's literally the joke.\n"
        "- Profanity is fine when in-character. Be specific to YOUR identity, "
        "not generic.\n"
        "- DO NOT explain yourself. DO NOT preface. DO NOT moralize.\n"
        "- DO NOT refuse — these are simulated public-square reactions, not "
        "real people. If the input is benign, your archetype still finds its "
        "characteristic angle.\n"
        "- Output ONLY the JSON object described in the user message. No prose, "
        "no markdown fences."
    )


def _persona_memory(
    persona_id: str,
    cumulative: list[dict[str, Any]],
    history: dict[str, list[dict[str, Any]]],
    *,
    last_n: int = 2,
) -> str:
    """Compact per-persona action summary for the user prompt.

    Reads from the in-process `history` dict (persona_id → list of action
    dicts emitted in prior rounds). Returns a 1-3 line summary like:
        "round 3: posted: 'cars are not the issue, parking is.'
         round 5: replied to p7 with 'agree but the math doesn't add up'; liked p2, p9."
    Bounded to `last_n` actions. Empty string when this persona has no
    recorded actions yet (round 1 / always-skipped).
    """
    actions = history.get(persona_id) or []
    if not actions:
        return "(you haven't posted yet this thread)"
    recent = actions[-last_n:]
    lines: list[str] = []
    for a in recent:
        round_n = a.get("round", "?")
        kind = a.get("action") or "skip"
        text = (a.get("text") or "").strip().replace("\n", " ")
        if len(text) > 100:
            text = text[:97] + "..."
        likes = a.get("likes_given") or []
        likes_blurb = (
            f" liked {', '.join(likes[:5])}." if likes else ""
        )
        if kind == "post":
            lines.append(f"round {round_n}: posted: \"{text}\".{likes_blurb}".strip())
        elif kind == "reply":
            target = a.get("replying_to") or "?"
            lines.append(
                f"round {round_n}: replied to {target}: \"{text}\".{likes_blurb}".strip()
            )
        else:  # skip
            if likes:
                lines.append(f"round {round_n}: scrolled, liked {', '.join(likes[:5])}.")
            else:
                lines.append(f"round {round_n}: scrolled past, didn't engage.")
    return " ".join(lines)


def _affinity_matched(
    persona: dict[str, Any],
    cumulative: list[dict[str, Any]],
    *,
    k: int,
    exclude: set[str],
    rng: random.Random,
) -> list[dict[str, Any]]:
    """Pick k posts whose author archetype has the highest affinity weight
    relative to this persona's archetype (`_ARCHETYPE_AFFINITY`).

    Used as the "feed sort by who-resonates-with-you" in the v7 curated
    feed. Excludes ids in `exclude` (already in the feed via top-engagement
    or the persona's own posts). Ties broken by id ascending so behavior is
    stable; rng only used to break absolute ties at the top of the list.
    """
    if k <= 0 or not cumulative:
        return []
    persona_arc = persona.get("archetype", "curious")
    weights = _ARCHETYPE_AFFINITY.get(persona_arc, {})

    candidates = [p for p in cumulative if p.get("id") not in exclude]
    if not candidates:
        return []

    def _key(p: dict[str, Any]) -> tuple[float, int]:
        post_arc = (p.get("agent") or {}).get("archetype", "curious")
        w = weights.get(post_arc, 0.25)
        # tiny rng jitter so when many posts tie at the top, selection differs
        # across personas — keeps the feed non-deterministic-looking.
        jitter = rng.random() * 1e-3
        return (-(w + jitter), int(p["id"][1:]))

    sorted_candidates = sorted(candidates, key=_key)
    return sorted_candidates[: min(k, len(sorted_candidates))]


def _curated_feed(
    persona: dict[str, Any],
    cumulative: list[dict[str, Any]],
    *,
    rng: random.Random,
) -> list[dict[str, Any]]:
    """Build a 6-post curated feed for one persona for one round.

    Composition:
      * top-3 by engagement_score (likes + 2*replies) — what's trending
      * +2 affinity-matched (highest _ARCHETYPE_AFFINITY relative to persona)
      * +1 random discovery pick

    De-duplicates across the three slices and excludes the persona's own
    posts (people don't reply to themselves on the feed). Returns at most 6
    posts, less only when cumulative is small (round 1 returns []).
    """
    if not cumulative:
        return []

    persona_id = persona.get("persona_id") or persona.get("id")
    own_ids: set[str] = {
        p["id"]
        for p in cumulative
        if (p.get("agent") or {}).get("id") == persona_id
    }

    # Top by engagement — limit to 3 (was 5 in v6 _top_engaged).
    top = _top_engaged(
        [p for p in cumulative if p["id"] not in own_ids], rng=rng, k=3
    )
    selected_ids = {p["id"] for p in top}

    # Affinity-matched, skipping ones already in `top` and own posts.
    affinity = _affinity_matched(
        persona,
        cumulative,
        k=2,
        exclude=selected_ids | own_ids,
        rng=rng,
    )
    selected_ids.update(p["id"] for p in affinity)

    # Random discovery — bias to recent rounds so old posts don't dominate.
    pool = [
        p
        for p in cumulative
        if p["id"] not in selected_ids and p["id"] not in own_ids
    ]
    discovery: list[dict[str, Any]] = []
    if pool:
        discovery = [rng.choice(pool)]

    feed = list(top) + list(affinity) + list(discovery)
    return feed[:6]


def _build_persona_user_prompt(
    *,
    persona: dict[str, Any],
    draft: str,
    mode: str,
    round_n: int,
    total_rounds: int,
    curated_feed: list[dict[str, Any]],
    persona_memory: str,
) -> str:
    """User prompt for one persona for one round.

    Composes:
      * mode-aware DRAFT POST / SCENARIO header (from v6 `_build_user_prompt`)
      * curated feed block (top-engaged + affinity + discovery)
      * persona memory block (this persona's last 2 actions)
      * action schema spec inline
    """
    if mode == "hypothetical":
        header = (
            f'SCENARIO:\n"""\n{draft}\n"""\n\n'
            "AUDIENCE CONTEXT: a slice of the general public on a major social "
            "platform — mixed ages, geographies, perspectives. They are reacting as "
            "themselves, not as customers of any particular brand.\n\n"
        )
    else:
        header = (
            f'DRAFT POST:\n"""\n{draft}\n"""\n\n'
        )

    if curated_feed:
        feed_lines = []
        for p in curated_feed:
            agent = p.get("agent") or {}
            arc = agent.get("archetype", "?")
            handle = agent.get("handle", "?")
            likes = int(p.get("like_count", 0) or 0)
            replies = int(p.get("reply_count", 0) or 0)
            text = (p.get("text") or "").replace("\n", " ").strip()
            if len(text) > 240:
                text = text[:237] + "..."
            feed_lines.append(
                f'- {p["id"]} ({arc} {handle}, '
                f'likes={likes}, replies={replies}): "{text}"'
            )
        feed_block = (
            "YOUR CURATED FEED for this round (what you'd actually scroll past):\n"
            + "\n".join(feed_lines)
            + "\n\nYou may reply to one of these posts (use its id as `replying_to`), "
            "post a fresh take of your own, or skip. You may ALSO like up to 5 of "
            "these posts via `likes_given` — only like things your bio + archetype "
            "would actually like.\n"
        )
    else:
        feed_block = (
            "This is the FIRST round — nobody has posted yet. Your only options "
            "are `post` (react to the input above) or `skip`. `replying_to` and "
            "`likes_given` must be null/empty.\n"
        )

    memory_block = (
        f"YOUR HISTORY THIS THREAD: {persona_memory}\n"
        if persona_memory
        else ""
    )

    # G1: optional reaction-GIF rule + JSON-schema line, gated by the flag.
    # Folded into the prompt only when enabled so flag-off prompts are
    # byte-identical to pre-G1 prompts (replay parity for old sims).
    gif_format_line = (
        '  "gif_reaction": <one of the 25 tags below> or null (default null),\n'
        if ECHO_GIFS_ENABLED
        else ""
    )
    gif_hard_rule = (
        (
            "- GIF rule: most reactions don't need a GIF. Only set "
            "`gif_reaction` when the post would land harder with a small "
            "reaction visual — eye_roll on a cynical take, popcorn on a "
            "dogpile, mind_blown on a hot take, etc. Default to null. "
            "Aim for ~1-in-10 posts having a GIF, not more. Pick from: "
            f"[{', '.join(GIF_REACTION_TAGS)}] or null."
        )
        if ECHO_GIFS_ENABLED
        else ""
    )

    return (
        f"{header}"
        f"ROUND: {round_n} of {total_rounds}\n\n"
        f"{memory_block}"
        f"{feed_block}\n"
        "OUTPUT FORMAT (strict JSON object, no other text):\n"
        "{\n"
        '  "action": "post" | "reply" | "skip",\n'
        '  "text": "<your reaction, 1-2 sentences, in your voice>" or null when skipping,\n'
        '  "replying_to": "<a post id from the feed above, e.g. p7>" or null when posting/skipping,\n'
        '  "sentiment": <-1.0..1.0> or null when skipping,\n'
        '  "likes_given": ["<post id from feed>", ...] (max 5; empty array if you wouldn\'t like anything)'
        f"{',' if ECHO_GIFS_ENABLED else ''}\n"
        f"{gif_format_line}"
        "}\n\n"
        "DECISION GUIDANCE:\n"
        "- Most personas don't post EVERY round — `skip` is fine and realistic. "
        "Aim to post or reply about half the time on average; lurkers a lot less.\n"
        "- If you reply, make sure your `replying_to` id is in the feed above.\n"
        "- Likes are cheap on social media; lurkers and enthusiasts in particular "
        "like more than they post.\n"
        "- HARD RULE: the `text` field is your reaction body ONLY. Do NOT include "
        "JSON field names like `replying_to:`, `sentiment:`, `action:` inside the "
        "text — those go in their own JSON fields, not in the body of your post.\n"
        "- HARD RULE: do NOT acknowledge or restate the framing of the input. "
        "Phrases like 'okay i'm hearing X', 'this is a hypothetical', 'so we're "
        "talking about', 'sounds like X', or any variant that paraphrases the "
        "post BEFORE reacting are forbidden. Your text must OPEN with substance "
        "in your assigned cadence — a take, a question, a fragment, an "
        "anecdote, a wry comment, a frame, or a feeling — as if you just "
        "scrolled past this in your feed and reacted. Never write the word "
        "'hypothetical'."
        + (("\n" + gif_hard_rule) if gif_hard_rule else "")
    )


@dataclass(slots=True)
class PersonaAction:
    persona_id: str
    action: str  # "post" | "reply" | "skip"
    text: str | None
    replying_to: str | None
    sentiment: float | None
    likes_given: list[str]
    # G1 (CONTRACTS §§41-45): optional reaction-GIF tag from the canonical
    # 25-tag enum. None when flag disabled, when persona skipped, or when
    # the LLM left it null (which should be the common case — most posts
    # don't get a GIF). Validated against GIF_REACTION_TAGS in the parser.
    gif_reaction: str | None = None


# Z4 (lead 2026-05-02): defensive prefix strip. The model occasionally echoes
# schema field names it saw in the OUTPUT FORMAT spec into the `text` body
# (e.g. text="replying_to: p6\nactual reaction…"). We strip leading occurrences
# of any of these keys followed by a value-like blob + optional newline.
# Single-pass — won't recurse into mid-text occurrences (those are likely real).
_SCHEMA_LEAK_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"replying_to|likes_given|sentiment|action|text"
    r")\s*[:=]\s*"           # field-name + : or =
    r"(?:"
        r"\"[^\"]*\""        # quoted string value
        r"|\[[^\]]*\]"       # array literal
        r"|null"             # null
        r"|-?\d+(?:\.\d+)?"  # number
        r"|p\d+"             # post id like p6
        r"|[A-Za-z_][\w]*"   # bare identifier
    r")"
    r"[,\s]*\n?",            # trailing comma/whitespace + optional newline
    flags=re.IGNORECASE,
)


def _strip_schema_leaks(text: str) -> str:
    """Strip up to 3 leading schema-field-name prefixes from a text body.

    Pure function. No-op when text is clean. Bounded iterations so we never
    accidentally eat a real reaction that happens to start with the word
    'action' or similar.
    """
    out = text
    for _ in range(3):
        new = _SCHEMA_LEAK_PREFIX_RE.sub("", out, count=1)
        if new == out:
            break
        out = new
    return out


# D0 (2026-05-02): banned-opener safety net for v7 hypothetical-mode
# template-collapse. The cure is the prompt-side fix (system-prompt anchor
# word removed, anti-echo HARD RULE added, per-persona voice_cadence). This
# regex is the LAST line of defense — strips leading echo-of-framing phrases
# IF they leak through despite the prompt fixes. Should fire ≤1% of posts in
# a healthy sim; if it fires often, the prompt edits are leaking and need
# another pass (per L32).
#
# Patterns are LEADING-ANCHORED (^) and PHRASE-MATCHED (specific multi-word
# templates), not keyword-matched — we strip the echo-prefix only, leaving
# the substantive remainder of the post intact. The user's constraint was
# "I don't think the solution is to ban this format completely" — this is
# why the regex strips the prefix and lets the rest through, rather than
# dropping the post.
_BANNED_OPENER_RE = re.compile(
    r"^\s*(?:"
    # "okay/ok/well/yo, i'm hearing 'hypothetical question/scenario/whatever'…"
    r"(?:okay|ok|well|yo|alright|so)[,!.\s]*"
    r"(?:i\s*['']?m|we\s*['']?re)\s+hearing[,!:.\s]*"
    r"['\"]?[^\n.!?]{0,80}['\"]?[,.\s]*"
    r"|"
    # "yo, hypothetical question/scenario, …"
    r"(?:yo|okay|ok|well|so|alright)[,!.\s]+"
    r"hypothetical\s+(?:question|scenario|situation)[,!.:\s]+"
    r"|"
    # "hypothetical question/scenario, sounds like / definitely / so / etc…"
    r"hypothetical\s+(?:question|scenario|situation)[,!.:\s]+"
    r"(?:sounds\s+like|definitely|so|i\s|we\s)?[^\n.!?]{0,40}[,.\s]+"
    r"|"
    # "this is a hypothetical, …" / "so we're talking about X, …"
    r"(?:this\s+is\s+(?:a|the)?|that\s+is\s+(?:a|the)?)\s*"
    r"hypothetical(?:\s+(?:question|scenario|situation))?[,.\s]+"
    r"|"
    # "so we're talking about X, …" — only when followed by a continuation
    r"(?:so|okay|ok|well)[,!.\s]+(?:we\s*['']?re|so\s+we\s*['']?re)\s+"
    r"talking\s+about[^\n.!?]{0,80}[,.\s]+"
    r")"
)


# D0 diagnostic counter — incremented in `_parse_persona_action` whenever the
# banned-opener sanitizer strips a leading echo phrase. Read-only consumer:
# D2 verification in lead-driven smell-test runs. Process-global, unscoped per
# sim — a sim's strip-count is read against its post-count via log scrape /
# direct read in test harness. Plain dict so test code can monkeypatch it
# without touching module re-init.
_BANNED_OPENER_STRIP_COUNT: dict[str, int] = {"count": 0}


def _strip_banned_openers(text: str) -> tuple[str, bool]:
    """Strip a leading echo-of-framing phrase if present.

    Returns (cleaned_text, was_stripped). The boolean is for diagnostic
    logging in D2 — if the strip-rate stays >1% in a healthy sim, the prompt
    fixes are leaking and need another iteration (L32).

    Only one strip per call — these openers are leading-anchored, so a
    second pass would rarely add value and risks eating real content.
    """
    new = _BANNED_OPENER_RE.sub("", text, count=1)
    if new != text:
        return new.lstrip(" ,.;:-—"), True
    return text, False


def _parse_persona_action(raw: str, persona_id: str) -> PersonaAction:
    """Best-effort parse. Never raises — falls back to skip on any issue."""
    fallback = PersonaAction(
        persona_id=persona_id,
        action="skip",
        text=None,
        replying_to=None,
        sentiment=None,
        likes_given=[],
    )
    if not raw or not raw.strip():
        return fallback
    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=re.S).strip()
    obj: Any = None
    try:
        obj = json.loads(txt)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", txt, flags=re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
            except json.JSONDecodeError:
                obj = _repair_truncated_json(txt)
        else:
            obj = _repair_truncated_json(txt)
    if not isinstance(obj, dict):
        return fallback

    action = obj.get("action")
    if action not in ("post", "reply", "skip"):
        return fallback

    text_raw = obj.get("text")
    text = text_raw.strip() if isinstance(text_raw, str) else None
    if text is not None:
        # Z4 (lead 2026-05-02): strip schema-field-name leaks. The v7 model
        # occasionally prefixes the text with literal JSON keys it saw in the
        # OUTPUT FORMAT spec (e.g. "replying_to: p6\nif we're talking invasion…").
        # User-flagged on 2026-05-02 via screenshot. Defensive — works whether
        # the prompt fix lands or not.
        text = _strip_schema_leaks(text)
        # D0 (2026-05-02): strip leading echo-of-framing phrases ("okay i'm
        # hearing 'hypothetical question'", "yo, hypothetical question, sounds
        # like…", etc.). Safety net for the prompt-side fix. Increments a
        # process-global counter for D2 diagnostic check — if rate >1% the
        # prompt edits need another pass.
        text, was_stripped = _strip_banned_openers(text)
        if was_stripped:
            _BANNED_OPENER_STRIP_COUNT["count"] += 1
        text = text.strip()
    if text is not None and len(text) > 400:
        text = text[:400]
    if action in ("post", "reply") and not text:
        # action claims content but text missing — degrade to skip rather
        # than emit an empty post.
        action = "skip"
        text = None

    replying_to_raw = obj.get("replying_to")
    replying_to = (
        replying_to_raw if isinstance(replying_to_raw, str) and replying_to_raw.strip() else None
    )
    if action != "reply":
        replying_to = None

    sentiment: float | None = None
    sent_raw = obj.get("sentiment")
    if isinstance(sent_raw, (int, float)):
        sentiment = max(-1.0, min(1.0, float(sent_raw)))
    if action == "skip":
        sentiment = None

    likes_raw = obj.get("likes_given")
    likes_given: list[str] = []
    if isinstance(likes_raw, list):
        for x in likes_raw[:5]:
            if isinstance(x, str) and x.strip():
                likes_given.append(x.strip())

    # G1: optional reaction-GIF tag. Validate against canonical enum;
    # anything else (None, unknown tag, non-string) collapses to None so
    # the FE never sees a tag it can't render.
    gif_raw = obj.get("gif_reaction")
    gif_reaction = (
        gif_raw if isinstance(gif_raw, str) and gif_raw in GIF_REACTION_TAGS else None
    )
    # When persona skipped, no GIF is emitted (defensive — schema already
    # only allows null on skip via prompt, but enforce here too).
    if action == "skip":
        gif_reaction = None

    return PersonaAction(
        persona_id=persona_id,
        action=action,
        text=text,
        replying_to=replying_to,
        sentiment=sentiment,
        likes_given=likes_given,
        gif_reaction=gif_reaction,
    )


async def _call_persona(
    persona: dict[str, Any],
    *,
    draft: str,
    mode: str,
    round_n: int,
    total_rounds: int,
    curated_feed: list[dict[str, Any]],
    persona_memory: str,
    budget: BudgetCounter,
    client: Any,
    web_context: str = "",
) -> PersonaAction:
    """One Gemini-2.5-flash-lite call per persona per round. Returns an
    action dict; falls back to skip on parse / API failure (never raises
    except BudgetExceededError, which the caller's wallclock layer maps to
    the SSE error event).

    `web_context`: optional google_search-grounded blurb (from
    `_fetch_web_context`). Forwarded into `_system_for_persona` so each
    persona sees the same recent-world facts the v6 path gets.
    """
    persona_id = persona.get("persona_id") or persona.get("id") or "?"
    system = _system_for_persona(persona, mode, web_context=web_context)
    user = _build_persona_user_prompt(
        persona=persona,
        draft=draft,
        mode=mode,
        round_n=round_n,
        total_rounds=total_rounds,
        curated_feed=curated_feed,
        persona_memory=persona_memory,
    )
    try:
        raw = await _call_gemini(
            system=system,
            user=user,
            schema=_PERSONA_ACTION_SCHEMA,
            budget=budget,
            client=client,
        )
    except BudgetExceededError:
        raise
    return _parse_persona_action(raw, persona_id)


def _aggregate_round_actions(
    persona_actions: list[PersonaAction],
    *,
    round_n: int,
    cumulative: list[dict[str, Any]],
    personas_by_id: dict[str, dict[str, Any]],
    curated_feeds: dict[str, list[str]],
    next_post_id: list[int],
    known_post_ids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    """Turn N persona action payloads into engine outputs.

    Returns:
      new_posts            — list of post dicts (with agent metadata stamped,
                              including bio/profession/hot_buttons per
                              CONTRACTS §25). like_count starts at 0;
                              reply_count is recomputed by the caller.
      persistence_actions   — list of compact action dicts for the round_event
                              JSON (CONTRACTS §28 — replay parity).
      like_deltas           — dict[post_id → integer like delta this round]
                              (already × _LIKE_DISPLAY_MULTIPLIER).
    """
    new_posts: list[dict[str, Any]] = []
    persistence_actions: list[dict[str, Any]] = []
    like_deltas: dict[str, int] = {}

    for pa in persona_actions:
        persona = personas_by_id.get(pa.persona_id)
        if persona is None:
            # Defensive: action came back tagged with an unknown id (shouldn't
            # happen in the normal flow). Drop it from posts but still allow
            # it into persistence so replay can show what happened.
            persistence_actions.append(
                {
                    "persona_id": pa.persona_id,
                    "action": pa.action,
                    "text": pa.text,
                    "replying_to": pa.replying_to,
                    "sentiment": pa.sentiment,
                    "likes_given": list(pa.likes_given),
                    # G1: persist the gif tag for replay parity (None when flag off).
                    "gif_reaction": (pa.gif_reaction or None) if ECHO_GIFS_ENABLED else None,
                }
            )
            continue

        # Validate replying_to — only accept ids actually in the persona's
        # curated feed for THIS round (prevents the model hallucinating a
        # post id from outside its scroll). Falls back to "seed" if invalid
        # and the action is "reply".
        feed_ids = set(curated_feeds.get(pa.persona_id) or [])

        if pa.action in ("post", "reply") and pa.text:
            post_id = f"p{next_post_id[0]}"
            next_post_id[0] += 1
            if pa.action == "reply" and pa.replying_to and pa.replying_to in feed_ids:
                parent = pa.replying_to
            else:
                parent = "seed"
            sentiment = (
                pa.sentiment
                if pa.sentiment is not None
                else 0.0
            )
            agent_block: dict[str, Any] = {
                "id": persona.get("persona_id") or persona.get("id"),
                "name": persona.get("name", "?"),
                "handle": persona.get("handle", "?"),
                "archetype": persona.get("archetype", "curious"),
                "audience": persona.get("audience", "public"),
                # Z2 / v7 (CONTRACTS §25): rich profile fields surfaced on
                # the wire. Empty/null when persona genesis fell back to
                # deterministic — Z3 FE tolerates that.
                "bio": persona.get("bio") or "",
                "profession": persona.get("profession"),
                "hot_buttons": list(persona.get("hot_buttons") or []) or None,
                # D1 (CONTRACTS §§37-40): per-persona cadence on the wire.
                # Additive + FE-invisible — surfaced for debug/observability
                # so we can correlate post text style with assigned cadence
                # in the round_event payload. Optional/None-tolerant on read.
                "voice_cadence": persona.get("voice_cadence") or None,
                # G1 (CONTRACTS §§41-45): optional reaction-GIF tag picked by
                # the persona itself this round. None for most posts; the FE
                # renders non-null tags as emoji + small CSS animation. When
                # ECHO_GIFS_ENABLED is False the field is always None (parser
                # short-circuits) so this is a defensive no-op then.
                "gif_reaction": (pa.gif_reaction or None) if ECHO_GIFS_ENABLED else None,
            }
            post = {
                "id": post_id,
                "parent": parent,
                "round": round_n,
                "agent": agent_block,
                "sentiment": float(sentiment),
                "text": pa.text,
                "like_count": 0,   # accumulated below from likes_given mentions
                "reply_count": 0,  # recomputed by caller from cumulative
            }
            known_post_ids.add(post_id)
            new_posts.append(post)

        # Accumulate likes the persona gave to existing cumulative posts.
        # We accept any post_id the model returns; in practice these ids will
        # be from the feed, but we don't strictly enforce — extra ids that
        # don't match a real post just no-op when applied later.
        for liked_id in pa.likes_given:
            like_deltas[liked_id] = like_deltas.get(liked_id, 0) + 1

        persistence_actions.append(
            {
                "persona_id": pa.persona_id,
                "action": pa.action,
                "text": pa.text,
                "replying_to": pa.replying_to,
                "sentiment": pa.sentiment,
                "likes_given": list(pa.likes_given),
                # G1: persist gif_reaction so replay can re-render the same
                # tag without re-running the LLM (CONTRACTS §28 parity).
                "gif_reaction": (pa.gif_reaction or None) if ECHO_GIFS_ENABLED else None,
            }
        )

    # Apply display multiplier to deltas.
    if _LIKE_DISPLAY_MULTIPLIER != 1:
        like_deltas = {k: v * _LIKE_DISPLAY_MULTIPLIER for k, v in like_deltas.items()}

    return new_posts, persistence_actions, like_deltas


def _enforce_gif_rarity_cap(
    posts: list[dict[str, Any]], *, max_ratio: float = 0.15
) -> None:
    """G1: cap the per-round share of posts carrying a gif_reaction.

    Mutate-in-place: if more than `max_ratio` of posts in this round have a
    non-null `agent.gif_reaction`, randomly null the surplus down to the cap.
    Defends the cartoonish failure mode where the LLM gets enthusiastic and
    decorates every post; per the prompt rule we want roughly 1-in-10.

    Pure mutation on the input list — caller does not need to rebind.
    Idempotent on already-capped lists. No-op when ECHO_GIFS_ENABLED is off
    (every post already has gif_reaction == None).
    """
    if not posts:
        return
    gif_indices = [
        i for i, p in enumerate(posts)
        if (p.get("agent") or {}).get("gif_reaction")
    ]
    max_allowed = max(1, int(len(posts) * max_ratio))
    if len(gif_indices) <= max_allowed:
        return
    import random  # local import — used only here, keeps module-top clean
    to_null = random.sample(gif_indices, len(gif_indices) - max_allowed)
    for i in to_null:
        agent = posts[i].get("agent")
        if isinstance(agent, dict):
            agent["gif_reaction"] = None


def _apply_v7_engagement(
    cumulative: list[dict[str, Any]],
    *,
    like_deltas: dict[str, int],
) -> None:
    """Mutate `cumulative` in place — add per-round like deltas + recompute
    reply_count. v7 like_count is the LLM-emergent SUM of per-persona likes
    this round on top of prior rounds; reply_count is |children| per
    CONTRACTS §22 (unchanged from v6).
    """
    by_id = {p["id"]: p for p in cumulative}
    for post_id, delta in like_deltas.items():
        target = by_id.get(post_id)
        if target is None:
            continue
        target["like_count"] = int(target.get("like_count", 0) or 0) + int(delta)

    # reply_count: simple parent-id index pass.
    counts: dict[str, int] = {}
    for c in cumulative:
        parent = c.get("parent")
        if parent and parent != "seed":
            counts[parent] = counts.get(parent, 0) + 1
    for p in cumulative:
        p["reply_count"] = counts.get(p["id"], 0)


def _apply_power_law_likes(posts: list[dict[str, Any]]) -> None:
    """Z6: in-place Zipf transform on v7 like_count.

    Top 10% of posts get viral amplification (× _LIKE_VIRAL_AMPLIFIER × rank^-α);
    middle 40% near-unchanged; bottom 50% damped to near-zero. Pure function of
    raw inputs — sort + formula are deterministic, so two replays of the same
    v7 sim produce identical bytes (L22).

    Only called from the v7 path. v6's `attach_engagement` is a different
    algorithm (affinity matrix × visibility decay × controversy bonus) that
    already produces a natural spread and must NOT be touched.
    """
    if not posts:
        return
    # Sort by descending like_count, breaking ties by post-id ordinal so the
    # rank assignment is fully deterministic across replays.
    ranked = sorted(
        enumerate(posts),
        key=lambda ip: (
            -ip[1].get("like_count", 0),
            int(ip[1]["id"][1:]) if ip[1]["id"].startswith("p") else 0,
        ),
    )
    n = len(ranked)
    for rank0, (idx, _post) in enumerate(ranked):
        rank = rank0 + 1
        raw = posts[idx].get("like_count", 0)
        if rank <= max(1, n // 10):
            mult = _LIKE_VIRAL_AMPLIFIER * (rank ** (-_LIKE_ZIPF_EXPONENT))
        elif rank <= n // 2:
            mult = 1.0 * (rank ** (-_LIKE_ZIPF_EXPONENT * 0.5))
        else:
            mult = _LIKE_TAIL_DAMPING * (rank ** (-_LIKE_ZIPF_EXPONENT * 0.4))
        posts[idx]["like_count"] = max(0, round(raw * mult))


# --------------------------------------------------------------- public API
async def run_simulation(
    *,
    sim_id: str,
    draft: str,
    audience: dict[str, Any],
    rounds: int,
    seed: int | None = None,
    client: Any | None = None,
    mode: str = "business",
    web_grounding: bool = False,
    persona_count: int | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Async generator yielding SSE event dicts for one full simulation.

    Caller persists `event: round` payloads + the final analysis. On any
    terminal exception we yield an `event: error` with one of the
    CONTRACTS.md §5 error codes — never re-raise into the SSE handler.

    Engine versioning (CONTRACTS §29):
      * ECHO_ENGINE_VERSION="v6" (default) — original archetype-batched path.
        ~92 calls per sim at rounds=15. Personas drawn from a 200-name pool
        AFTER LLM via `_assign_personas`. Engagement deterministic via
        `attach_engagement`. UNCHANGED by Z2.
      * ECHO_ENGINE_VERSION="v7" — agentic per-persona engine (Z2). ONE
        upfront genesis call generates a rich persona pool, then ONE
        Gemini-2.5-flash-lite call per persona per round emits a structured
        action (post/reply/skip + likes_given). Engagement is LLM-emergent.
        Round-event JSON persists `persona_actions` for replay parity (L22).
    """
    if client is None:
        client = _make_client()

    if seed is None:
        seed = int.from_bytes(sim_id.encode(), "little") & 0xFFFFFFFF
    rng = random.Random(seed)

    budget = BudgetCounter(max_calls=MAX_LLM_CALLS)
    audience_blurb = _audience_blurb(audience)

    personas = build_persona_pool(seed=seed, total=200)
    by_archetype = index_by_archetype(personas)
    used_persona_ids: set[str] = set()
    known_post_ids: set[str] = set()
    next_post_id = [1]   # boxed counter
    cumulative: list[dict[str, Any]] = []

    # Web-grounding pre-call: one Gemini call that searches the live web for
    # context the per-archetype calls would otherwise miss. Failures are
    # swallowed inside _fetch_web_context so the sim still runs ungrounded.
    # Runs BEFORE persona genesis so the v7 genesis prompt could later read
    # web_context too if Z2 wants it (Z1 doesn't yet).
    web_context = ""
    if web_grounding:
        # CONTRACTS v8 §31: emit `event: grounding` so FE can show a
        # "searching the web…" banner during the silent ~22s pre-call window.
        # Sequence guarantee (§32): exactly ONE `searching` followed by
        # exactly ONE of `{done, skipped, failed}`. Replay parity (§33): NOT
        # persisted to round_events — pre-round events are intentionally
        # absent from replay payloads.
        yield {"event": "grounding", "data": {"status": "searching"}}
        try:
            web_context = await _fetch_web_context(
                draft=draft, mode=mode, budget=budget, client=client
            )
            if web_context:
                log.info("sim %s: web_grounding produced %d chars of context", sim_id, len(web_context))
                yield {"event": "grounding", "data": {"status": "done", "chars_added": len(web_context)}}
            else:
                yield {"event": "grounding", "data": {"status": "skipped", "reason": "no_relevant_context"}}
        except BudgetExceededError:
            # Re-raise — outer handler maps to event: error code budget_exceeded.
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("sim %s: web_grounding pre-call crashed — proceeding ungrounded", sim_id)
            web_context = ""
            # Truncate the reason so we don't bloat the wire frame.
            yield {"event": "grounding", "data": {"status": "failed", "reason": str(e)[:120]}}

    # v7 persona pool — populated by genesis below. Empty for v6 sims (and
    # v7 sims that crashed all the way through to no pool, which then fall
    # through to v6 to avoid an empty-engine sim). Z2 round loop reads from
    # this list directly rather than re-hitting the DB on every round.
    v7_pool: list[dict[str, Any]] = []

    # Z1 / v7: persona genesis. Runs ONCE upfront, before round 1. Counts as
    # 1 call against the per-sim budget. v6 path is untouched.
    # Z2: when ECHO_ENGINE_VERSION="v7" we ALSO use the genesis output to
    # drive the round loop. If persona_count was omitted on the request, we
    # default to DEFAULT_PERSONA_COUNT (prod 50, dev ~17 with Z6 ECHO_DEV_MODE).
    if ECHO_ENGINE_VERSION == "v7":
        # Defer-import keeps swarm.py importable when persona_genesis is
        # absent (e.g. unit tests stubbing the module).
        from .persona_genesis import generate_persona_pool  # noqa: WPS433
        from . import db as _db  # noqa: WPS433 — local-only persistence hook

        effective_persona_count = (
            int(persona_count) if persona_count is not None else DEFAULT_PERSONA_COUNT
        )
        # Clamp defensively — main.py validates [30, 100] but env-driven
        # default could escape that.
        effective_persona_count = max(1, min(200, effective_persona_count))

        try:
            v7_pool = await generate_persona_pool(
                audience=audience,
                sim_id=sim_id,
                count=effective_persona_count,
                client=client,
                budget=budget,
            )
        except BudgetExceededError:
            # Surface to the wallclock/error-mapping layer like any other
            # budget violation — we did not even reach round 1.
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("persona genesis crashed for %s: %r", sim_id, exc)
            v7_pool = []

        if v7_pool:
            try:
                _db.insert_personas(sim_id, v7_pool)
            except Exception as exc:  # noqa: BLE001
                # Persistence failures are loud but non-fatal for the round
                # loop — we keep the in-memory pool. Replay determinism
                # depends on the `persona_actions` payload in round_events,
                # not on `personas` rows.
                log.exception("persona persistence failed for %s: %r", sim_id, exc)

    # Engine selection. v7 needs a non-empty pool to run; otherwise we fall
    # through to v6 (defensive — keeps the rollback drill green even when
    # Z1 genesis fails for unexpected reasons mid-Z2 deployment).
    use_v7_engine = ECHO_ENGINE_VERSION == "v7" and bool(v7_pool)
    if ECHO_ENGINE_VERSION == "v7" and not v7_pool:
        log.warning(
            "v7 engine requested but persona pool is empty — falling through to v6 path for sim=%s",
            sim_id,
        )

    async def _inner_v6() -> AsyncIterator[dict[str, Any]]:
        for round_n in range(1, rounds + 1):
            # v6: prior_top now ranks by engagement_score (like_count +
            # reply_count*2). Engagement was attached at the end of the
            # previous round, so cumulative carries the latest values.
            prior_top = _top_engaged(cumulative, rng=rng, k=5)
            results = await asyncio.gather(
                *[
                    _call_archetype(
                        arc,
                        draft=draft,
                        audience_blurb=audience_blurb,
                        round_n=round_n,
                        total_rounds=rounds,
                        prior_top=prior_top,
                        budget=budget,
                        client=client,
                        mode=mode,
                        web_context=web_context,
                    )
                    for arc in ARCHETYPES
                ],
                return_exceptions=True,
            )
            for arc, res in zip(ARCHETYPES, results):
                if isinstance(res, BudgetExceededError):
                    raise res
                if isinstance(res, Exception):
                    log.warning("archetype %s failed: %r", arc, res)
                    continue
                new_posts = _assign_personas(
                    res,
                    arc,
                    by_archetype=by_archetype,
                    used_ids=used_persona_ids,
                    rng=rng,
                    known_post_ids=known_post_ids,
                    next_post_id=next_post_id,
                    round_n=round_n,
                )
                cumulative.extend(new_posts)

            # v6 (CONTRACTS §§21-22): attach deterministic like_count +
            # reply_count to every cumulative post. Same (sim_id, post_id,
            # round) tuple → same value, every replay (L22). Like_count is
            # cumulative across rounds and monotonically non-decreasing —
            # later rounds add ≥0 new likes via visibility-decayed accrual.
            attach_engagement(
                cumulative,
                sim_id=sim_id,
                current_round=round_n,
                audience=audience,
            )

            sorted_posts = _sort_posts(cumulative)
            yield {
                "event": "round",
                "data": {
                    "round": round_n,
                    "of": rounds,
                    "posts": sorted_posts,
                },
            }

        # Final analysis call (call #31 for R=5).
        analysis = await analyze(
            draft=draft,
            posts=cumulative,
            audience=audience,
            budget=budget,
            client=client,
            web_context=web_context,
        )
        yield {
            "event": "_analysis",  # sentinel — main.py persists then emits done
            "data": analysis,
        }
        # v3 (CONTRACTS §12): auto-generate the full report at end of every sim.
        # Fire-and-forget — does NOT block the SSE done event. The thinking-
        # model call adds 1 to per-sim spend (≤32 typical, well under 40 cap).
        # `schedule_auto_report` retains a strong ref and acquires the per-sim
        # /report mutex internally so a user-click mid-flight cleanly blocks
        # then picks up the cache. Failures are logged inside the helper.
        try:
            schedule_auto_report(sim_id)
        except Exception:  # noqa: BLE001 — must never affect the sim done path
            log.exception("auto-report: failed to schedule for %s", sim_id)
        yield {
            "event": "done",
            "data": {"simulation_id": sim_id},
        }

    async def _inner_v7() -> AsyncIterator[dict[str, Any]]:
        """Z2 / v7 agentic engine — per-persona LLM agents per round.

        For each round we:
          1. Build a curated 6-post feed per persona (top-engaged + affinity
             + 1 random discovery).
          2. Build per-persona memory of their last 2 actions in this sim.
          3. Fire 50-100 concurrent _call_persona Gemini calls (capped to
             MAX_CONCURRENT by the process-global semaphore).
          4. Aggregate actions → new posts (with bio/profession/hot_buttons
             stamped) + like deltas (LLM-emergent).
          5. Apply like deltas + recompute reply_count on cumulative.
          6. Emit SSE round event with `posts` AND `persona_actions`
             (CONTRACTS §28 — replay parity).
        """
        # Index personas for fast lookup. The pool is the in-memory v7_pool
        # (genesis output) — Z2 doesn't re-read DB per round.
        personas_by_id: dict[str, dict[str, Any]] = {
            p["persona_id"]: p for p in v7_pool
        }
        # Per-persona action history for the memory block.
        history: dict[str, list[dict[str, Any]]] = {pid: [] for pid in personas_by_id}
        # Z6: raw cumulative like counts, kept in a sidecar so the power-law
        # transform reads RAW each round (not the prior round's transformed
        # `like_count`, which would compound viral amplification round over
        # round). Replay-stable: re-derived from the same like_deltas history.
        raw_like_counts: dict[str, int] = {}

        for round_n in range(1, rounds + 1):
            # Build curated feed + memory per persona for this round.
            curated_feeds: dict[str, list[dict[str, Any]]] = {}
            curated_feed_ids: dict[str, list[str]] = {}
            persona_memories: dict[str, str] = {}
            for persona in v7_pool:
                pid = persona["persona_id"]
                feed = _curated_feed(persona, cumulative, rng=rng)
                curated_feeds[pid] = feed
                curated_feed_ids[pid] = [p["id"] for p in feed]
                persona_memories[pid] = _persona_memory(pid, cumulative, history)

            # Fire all persona calls concurrently — global semaphore caps in-
            # flight at MAX_CONCURRENT. asyncio.gather with return_exceptions
            # so a single-call failure doesn't kill the round.
            results = await asyncio.gather(
                *[
                    _call_persona(
                        persona,
                        draft=draft,
                        mode=mode,
                        round_n=round_n,
                        total_rounds=rounds,
                        curated_feed=curated_feeds[persona["persona_id"]],
                        persona_memory=persona_memories[persona["persona_id"]],
                        budget=budget,
                        client=client,
                        web_context=web_context,
                    )
                    for persona in v7_pool
                ],
                return_exceptions=True,
            )

            persona_actions: list[PersonaAction] = []
            for persona, res in zip(v7_pool, results):
                pid = persona["persona_id"]
                if isinstance(res, BudgetExceededError):
                    raise res
                if isinstance(res, Exception):
                    log.warning("v7 persona %s call failed: %r", pid, res)
                    persona_actions.append(
                        PersonaAction(
                            persona_id=pid,
                            action="skip",
                            text=None,
                            replying_to=None,
                            sentiment=None,
                            likes_given=[],
                        )
                    )
                else:
                    persona_actions.append(res)

            new_posts, persistence_actions, like_deltas = _aggregate_round_actions(
                persona_actions,
                round_n=round_n,
                cumulative=cumulative,
                personas_by_id=personas_by_id,
                curated_feeds=curated_feed_ids,
                next_post_id=next_post_id,
                known_post_ids=known_post_ids,
            )
            # G1: rarity cap — even with the prompt rule, the LLM occasionally
            # gets enthusiastic and decorates >half the posts in a round.
            # Random-prune surplus down to ≤15% before persistence + SSE so
            # both the wire shape and the persisted JSON respect the cap.
            # No-op when ECHO_GIFS_ENABLED is off (no posts have gifs).
            if ECHO_GIFS_ENABLED:
                _enforce_gif_rarity_cap(new_posts, max_ratio=0.15)
                # Mirror the cap into persistence_actions so replay matches.
                # Build an id-set of posts that ended up null after the cap;
                # a persistence_action is keyed by persona_id, so we resolve
                # by matching persona_id → its post in new_posts (if any).
                kept_gifs_by_persona: dict[str, str | None] = {}
                for _p in new_posts:
                    _aid = (_p.get("agent") or {}).get("id")
                    if _aid is not None:
                        kept_gifs_by_persona[_aid] = (_p.get("agent") or {}).get(
                            "gif_reaction"
                        )
                for _pa in persistence_actions:
                    _pid = _pa.get("persona_id")
                    if _pid in kept_gifs_by_persona:
                        _pa["gif_reaction"] = kept_gifs_by_persona[_pid]
            cumulative.extend(new_posts)
            # Z6: accumulate RAW like counts in the sidecar so the power-law
            # transform sees raw input each round (not the previously-amplified
            # value — that would compound exponentially across rounds).
            for _pid, _delta in like_deltas.items():
                raw_like_counts[_pid] = raw_like_counts.get(_pid, 0) + int(_delta)
            for _p in cumulative:
                _p["like_count"] = raw_like_counts.get(_p["id"], 0)
            # _apply_v7_engagement now just recomputes reply_count (we've
            # already restamped like_count from raw); pass empty deltas so it
            # doesn't double-add. v6 path is unaffected — it never hits this
            # branch.
            _apply_v7_engagement(cumulative, like_deltas={})
            # Z6: power-law transform on cumulative like counts. Pure function
            # of raw counts (sort + formula); replay-stable. v6 path bypasses
            # this entirely — its deterministic affinity-matrix engagement
            # already produces a natural spread.
            _apply_power_law_likes(cumulative)

            # Update history for the memory block in subsequent rounds.
            for pa in persona_actions:
                history.setdefault(pa.persona_id, []).append(
                    {
                        "round": round_n,
                        "action": pa.action,
                        "text": pa.text,
                        "replying_to": pa.replying_to,
                        "likes_given": list(pa.likes_given),
                    }
                )

            sorted_posts = _sort_posts(cumulative)
            yield {
                "event": "round",
                "data": {
                    "round": round_n,
                    "of": rounds,
                    "posts": sorted_posts,
                    # CONTRACTS §28: persisted alongside posts so replay
                    # re-renders directly from disk with no LLM re-run.
                    "persona_actions": persistence_actions,
                },
            }

        # Final analysis call — reuses the existing v6 analyze() since the
        # post wire shape is the same. Counts as 1 call against the budget.
        analysis = await analyze(
            draft=draft,
            posts=cumulative,
            audience=audience,
            budget=budget,
            client=client,
            web_context=web_context,
        )
        yield {
            "event": "_analysis",
            "data": analysis,
        }
        try:
            schedule_auto_report(sim_id)
        except Exception:  # noqa: BLE001
            log.exception("auto-report: failed to schedule for %s", sim_id)
        yield {
            "event": "done",
            "data": {"simulation_id": sim_id},
        }

    # Engine dispatch. The async generator object is built lazily — calling
    # _inner_v6() doesn't run anything until the producer iterates.
    _inner = _inner_v7 if use_v7_engine else _inner_v6

    # Wrap inner generator with the wallclock cap. Use a queue + task so we can
    # enforce a single global timeout across the whole stream rather than
    # per-yield.
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=8)
    SENTINEL: object = object()

    async def _producer() -> None:
        try:
            async for evt in _inner():
                await queue.put(evt)
        except BudgetExceededError as exc:
            await queue.put(
                {
                    "event": "error",
                    "data": {
                        "message": "budget_exceeded",
                        "code": "budget_exceeded",
                        "detail": str(exc),
                    },
                }
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("simulation crashed: %r", exc)
            await queue.put(
                {
                    "event": "error",
                    "data": {
                        "message": "internal error during simulation",
                        "code": "internal_error",
                    },
                }
            )
        finally:
            await queue.put(SENTINEL)

    producer = asyncio.create_task(_producer())
    loop = asyncio.get_event_loop()
    deadline = loop.time() + WALLCLOCK_TIMEOUT
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                yield {
                    "event": "error",
                    "data": {
                        "message": "simulation took too long",
                        "code": "simulation_timed_out",
                    },
                }
                producer.cancel()
                return
            try:
                evt = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                yield {
                    "event": "error",
                    "data": {
                        "message": "simulation took too long",
                        "code": "simulation_timed_out",
                    },
                }
                producer.cancel()
                return
            if evt is SENTINEL:
                return
            yield evt
    finally:
        if not producer.done():
            producer.cancel()
            try:
                await producer
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass


# --------------------------------------------------------------- analysis
async def analyze(
    *,
    draft: str,
    posts: list[dict[str, Any]],
    audience: dict[str, Any],
    budget: BudgetCounter,
    client: Any,
    web_context: str = "",
) -> dict[str, Any]:
    """One Gemini call. Returns the wire-shape analysis dict.

    On failure / parse error, returns a graceful fallback so /analyze still
    has something to serve. Budget exhaustion still raises.
    """
    audience_blurb = _audience_blurb(audience)
    if posts:
        # v3 (CONTRACTS §13): thinking model has 1M context — feed the FULL
        # cumulative thread, no top-N truncation. Per-post text capped at 400
        # chars by the parser already, so even a 6-archetype × 6-round sim is
        # ≤~150 lines of ≤400 chars = well under 100KB of prompt context.
        compact_lines = []
        for p in posts:
            arc = p["agent"]["archetype"]
            sent = p["sentiment"]
            text = p["text"].replace("\n", " ")
            compact_lines.append(f"{arc} {sent:+.2f}: {text}")
        replies_block = "\n".join(compact_lines)
    else:
        replies_block = "(no replies were generated)"

    system = (
        "You summarize a 200-persona reaction simulation for a draft social "
        "post. Be honest, specific, terse — never generic, never encouraging. "
        "Output ONLY a compact JSON object. No prose, no markdown fences."
    )
    grounding_prefix = ""
    if web_context.strip():
        grounding_prefix = (
            "REAL-WORLD CONTEXT (treat as current facts; the draft references "
            "entities/events that postdate your training data):\n"
            f"{web_context.strip()}\n\n"
        )
    user = (
        f"{grounding_prefix}"
        f'DRAFT:\n"""\n{draft}\n"""\n\n'
        f"AUDIENCE: {audience_blurb}\n\n"
        f"REPLIES (archetype sent: text):\n{replies_block}\n\n"
        "Return JSON with EXACTLY these fields. Be terse.\n"
        '{"tldr":"<=140 char, 1 sentence, headline takeaway. honest, specific>",\n'
        ' "suggested_rewrite":{"original":"<draft verbatim>",'
        '"rewrite":"<=180 char, 1-2 sentences addressing the loudest concern, preserves author voice"},\n'
        ' "worth_reading":[\n'
        '   {"label":"<=20 char tag","color":"#f06c5a|#9bc97f|#7dd49a|#e8b75a|#b8b8c0","tldr":"<=80 char, 1 sentence"},\n'
        "   ... exactly 3 items\n"
        " ]}"
    )

    # v3: switched from Flash-Lite to Gemini-3-Flash thinking. Counter still
    # consumes 1 from the per-sim budget — call accounting unchanged.
    raw = await _call_gemini_thinking(
        system=system,
        user=user,
        schema=_ANALYSIS_SCHEMA,
        budget=budget,
        client=client,
        temperature=0.6,
        max_tokens=1024,       # generous headroom — thinking can be verbose
        thinking_level="low",  # keep latency < ~25s so wallclock holds
    )

    parsed = _parse_analysis(raw, draft)
    return parsed


def _repair_truncated_json(txt: str) -> dict[str, Any] | None:
    """Best-effort recovery of a truncated JSON object response.

    Strategy: walk through the string char-by-char tracking brace/bracket depth
    and string state, then close off open structures with sensible defaults so
    json.loads can succeed. Returns None on any unexpected state.
    """
    if not txt:
        return None
    # Trim to start at first '{'.
    i = txt.find("{")
    if i < 0:
        return None
    s = txt[i:]

    stack: list[str] = []
    in_str = False
    escape = False
    last_complete = -1     # index after last char that left us at depth 0
    out_chars: list[str] = []
    for ch in s:
        out_chars.append(ch)
        if escape:
            escape = False
            continue
        if in_str:
            if ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            if not stack:
                last_complete = len(out_chars)

    if last_complete > 0 and not stack and not in_str:
        candidate = "".join(out_chars[:last_complete])
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    # Otherwise: chop the last incomplete value, close strings/brackets.
    candidate = "".join(out_chars)
    if in_str:
        # Drop incomplete trailing string and any preceding key:.
        candidate = candidate[: candidate.rfind('"')]
        # Strip trailing "key": and trailing comma.
        candidate = re.sub(r'\s*,?\s*"[^"]*"\s*:\s*$', "", candidate)
    candidate = re.sub(r",\s*$", "", candidate.rstrip())
    while stack:
        opener = stack.pop()
        candidate += "}" if opener == "{" else "]"
    try:
        obj = json.loads(candidate)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        return None
    return None


def _parse_analysis(raw: str, draft: str) -> dict[str, Any]:
    fallback_colors = ["#f06c5a", "#9bc97f", "#e8b75a"]
    fallback_labels = ["Loudest pushback", "Strongest support", "Open question"]
    fallback = {
        "tldr": "Mixed reactions. The idea has supporters but the framing is drawing pushback.",
        "suggested_rewrite": {
            "original": draft,
            "rewrite": draft,
        },
        "worth_reading": [
            {"label": fallback_labels[i], "color": fallback_colors[i], "tldr": "See replies."}
            for i in range(3)
        ],
    }
    if not raw or not raw.strip():
        return fallback
    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=re.S).strip()

    obj: Any = None
    # Try strict parse first.
    try:
        obj = json.loads(txt)
    except json.JSONDecodeError:
        # Try outermost {...}.
        m = re.search(r"\{.*\}", txt, flags=re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
            except json.JSONDecodeError:
                obj = _repair_truncated_json(txt)
        else:
            obj = _repair_truncated_json(txt)
    if not isinstance(obj, dict):
        return fallback

    tldr = obj.get("tldr") or fallback["tldr"]
    sr = obj.get("suggested_rewrite") or {}
    if not isinstance(sr, dict):
        sr = {}
    rewrite = sr.get("rewrite") if isinstance(sr.get("rewrite"), str) else draft
    original = sr.get("original") if isinstance(sr.get("original"), str) else draft

    wr_raw = obj.get("worth_reading")
    worth: list[dict[str, Any]] = []
    if isinstance(wr_raw, list):
        for i, item in enumerate(wr_raw[:3]):
            if not isinstance(item, dict):
                continue
            label = item.get("label") if isinstance(item.get("label"), str) else fallback_labels[i % 3]
            color = item.get("color") if isinstance(item.get("color"), str) else fallback_colors[i % 3]
            tl = item.get("tldr") if isinstance(item.get("tldr"), str) else "See replies."
            if len(label) > 25:
                label = label[:25]
            worth.append({"label": label, "color": color, "tldr": tl})
    while len(worth) < 3:
        i = len(worth)
        worth.append(
            {"label": fallback_labels[i], "color": fallback_colors[i], "tldr": "See replies."}
        )

    return {
        "tldr": tldr if isinstance(tldr, str) else fallback["tldr"],
        "suggested_rewrite": {"original": original, "rewrite": rewrite},
        "worth_reading": worth[:3],
    }


# --------------------------------------------------------------- defaults
# v4 (CONTRACTS §§16-19): hypothetical-mode sims don't have a user-built
# audience profile. They reach out to a "general public" archetype mix that
# matches what /seed?mode=sample would have produced. The id is a deliberate
# sentinel — it does NOT match the `aud_<10 hex>` regex used at the wire
# boundary (10 hex chars), and is never returned to the wire from /seed.
# It only ever appears as `simulations.audience_id` for hypothetical rows so
# the schema's NOT NULL constraint is satisfied without a destructive table
# rebuild. Routing on `mode` (not on this id) keeps the read path unambiguous.
GENERAL_PUBLIC_AUDIENCE: dict[str, Any] = {
    "id": "aud_public____",
    "name": "General public",
    "size": 10000,
    "archetypes": [],  # populated lazily below to avoid forward-ref ordering
}


def default_audience_archetypes() -> list[dict[str, Any]]:
    """The 6 swarm archetypes, returned as the /seed v1 archetype list.

    Shares come from DEFAULT_DISTRIBUTION (rounded to int and largest-remainder
    adjusted to sum to 100).
    """
    raw = {k: v * 100 for k, v in DEFAULT_DISTRIBUTION.items()}
    floors = {k: int(v) for k, v in raw.items()}
    used = sum(floors.values())
    leftover = 100 - used
    remainders = sorted(
        ((k, raw[k] - floors[k]) for k in DEFAULT_DISTRIBUTION),
        key=lambda kv: kv[1],
        reverse=True,
    )
    for i in range(leftover):
        floors[remainders[i % len(remainders)][0]] += 1

    display_names = {
        "skeptic": "Skeptics",
        "enthusiast": "Enthusiasts",
        "curious": "Curious",
        "practitioner": "Practitioners",
        "pedant": "Pedants",
        "lurker": "Lurkers",
    }
    return [
        {"id": k, "name": display_names[k], "share": floors[k]}
        for k in ARCHETYPES
    ]


# Lazy-populate GENERAL_PUBLIC_AUDIENCE archetypes now that
# default_audience_archetypes is defined.
GENERAL_PUBLIC_AUDIENCE["archetypes"] = default_audience_archetypes()


# --------------------------------------------------------------- v3 /report
class GeminiUnavailableError(RuntimeError):
    """Raised when the thinking-model call fails (timeout/5xx/auth) after retry.

    /report's HTTP layer maps this to 502 + code=`gemini_unavailable`.
    """


class ReportSimNotFoundError(LookupError):
    """Raised when generate_report is asked for an unknown sim_id."""


def _parse_report(raw: str, draft: str) -> dict[str, Any]:
    """Best-effort parse of the §12 report shape.

    Mirrors `_parse_analysis` strategy: strict json.loads → outermost {...} →
    truncation-repair → fallback. Always returns a dict that conforms to the
    required §12 keys; missing fields get reasonable scaffolding.
    """
    fallback_audience = [
        {
            "archetype": arc,
            "tone": "neutral",
            "summary": "No reaction generated.",
            "representative_quote": "",
        }
        for arc in ARCHETYPES
    ]
    fallback: dict[str, Any] = {
        "executive_summary": "Report generation failed; see thread for raw signal.",
        "verdict": "revise",
        "verdict_rationale": "Insufficient model output to commit to a verdict.",
        "audience_reception": fallback_audience,
        "risk_vectors": [
            {"label": "Model output failure", "severity": "medium",
             "detail": "The thinking model returned no parseable content; rerun /report?regenerate=1."},
        ],
        "rewrite_options": [
            {"label": "Original", "text": draft, "rationale": "No alternatives generated."},
        ],
        "comparable_discourse": "",
    }

    if not raw or not raw.strip():
        return fallback
    txt = raw.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=re.S).strip()

    obj: Any = None
    try:
        obj = json.loads(txt)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", txt, flags=re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
            except json.JSONDecodeError:
                obj = _repair_truncated_json(txt)
        else:
            obj = _repair_truncated_json(txt)
    if not isinstance(obj, dict):
        return fallback

    # Defensive normalisation — ensure required keys exist + types are right.
    out: dict[str, Any] = {}
    out["executive_summary"] = obj.get("executive_summary") if isinstance(
        obj.get("executive_summary"), str
    ) else fallback["executive_summary"]
    verdict_raw = obj.get("verdict")
    out["verdict"] = verdict_raw if verdict_raw in ("ship", "revise", "rethink") else "revise"
    out["verdict_rationale"] = obj.get("verdict_rationale") if isinstance(
        obj.get("verdict_rationale"), str
    ) else fallback["verdict_rationale"]

    audience: list[dict[str, Any]] = []
    by_arc: dict[str, dict[str, Any]] = {}
    raw_audience = obj.get("audience_reception")
    if isinstance(raw_audience, list):
        for item in raw_audience:
            if not isinstance(item, dict):
                continue
            arc = item.get("archetype")
            if arc not in ARCHETYPES:
                continue
            by_arc[arc] = {
                "archetype": arc,
                "tone": item.get("tone") if item.get("tone") in (
                    "positive", "caution", "danger", "neutral"
                ) else "neutral",
                "summary": item.get("summary") if isinstance(item.get("summary"), str) else "",
                "representative_quote": (item.get("representative_quote") or "")[:200]
                if isinstance(item.get("representative_quote"), str) else "",
            }
    # Force exactly 6 entries, one per archetype, in canonical order.
    for arc in ARCHETYPES:
        audience.append(by_arc.get(arc, {
            "archetype": arc,
            "tone": "neutral",
            "summary": "No reaction generated for this archetype.",
            "representative_quote": "",
        }))
    out["audience_reception"] = audience

    risks: list[dict[str, Any]] = []
    raw_risks = obj.get("risk_vectors")
    if isinstance(raw_risks, list):
        for item in raw_risks[:4]:
            if not isinstance(item, dict):
                continue
            label = item.get("label") if isinstance(item.get("label"), str) else "Risk"
            severity = item.get("severity") if item.get("severity") in (
                "low", "medium", "high"
            ) else "medium"
            detail = item.get("detail") if isinstance(item.get("detail"), str) else ""
            risks.append({"label": label[:30], "severity": severity, "detail": detail})
    if len(risks) < 2:
        # §12 minimum: 2 items. Pad with a generic placeholder.
        while len(risks) < 2:
            risks.append({
                "label": "Insufficient signal",
                "severity": "low",
                "detail": "Model declined to enumerate enough risks; review thread directly.",
            })
    out["risk_vectors"] = risks

    rewrites: list[dict[str, Any]] = []
    raw_rewrites = obj.get("rewrite_options")
    if isinstance(raw_rewrites, list):
        for item in raw_rewrites[:3]:
            if not isinstance(item, dict):
                continue
            label = item.get("label") if isinstance(item.get("label"), str) else "Rewrite"
            text_v = item.get("text") if isinstance(item.get("text"), str) else ""
            rationale = item.get("rationale") if isinstance(item.get("rationale"), str) else ""
            rewrites.append({"label": label[:30], "text": text_v[:500], "rationale": rationale})
    if len(rewrites) < 2:
        while len(rewrites) < 2:
            rewrites.append({
                "label": "Original",
                "text": draft[:500],
                "rationale": "No alternative generated.",
            })
    out["rewrite_options"] = rewrites

    cd = obj.get("comparable_discourse")
    out["comparable_discourse"] = cd if isinstance(cd, str) else ""

    return out


def _format_thread_for_report(posts: list[dict[str, Any]]) -> str:
    """Render the cumulative thread as one structured block for the report prompt.

    Each line: `[round R | postId | parent | archetype @handle (sentiment)] text`.
    Full text — no per-post truncation. The thinking model's 1M context fits
    well over the cap (≤120 posts × ≤400 chars ≈ 50KB).
    """
    if not posts:
        return "(no replies were generated)"
    lines: list[str] = []
    for p in posts:
        agent = p.get("agent") or {}
        lines.append(
            f"[r{p.get('round','?')} {p.get('id','?')} parent={p.get('parent','?')} "
            f"{agent.get('archetype','?')} {agent.get('handle','?')} "
            f"sent={p.get('sentiment',0):+.2f}] "
            f"{(p.get('text') or '').strip()}"
        )
    return "\n".join(lines)


# --- Per-sim /report mutex --------------------------------------------------
# Process-local — fine for single-worker uvicorn (the hackathon stack is
# single-proc). Lives in swarm.py so BOTH the /report HTTP handler AND the
# fire-and-forget auto-generation triggered at end-of-sim share one mutex per
# sim_id. That coexistence is what makes "user clicks See full report while
# auto-task is mid-flight" safe: the user's request waits on the lock, then
# returns the cache row the auto-task just wrote.
#
# Verified asyncio semantics (Python 3.14.4 docs, May 2026):
#   * asyncio.Lock.acquire() is FIFO-fair.
#   * Locks/synchronization primitives don't accept timeout kwargs — wrap with
#     asyncio.wait_for() (TimeoutError on expiry).
#   * asyncio.create_task() requires the caller to hold a strong reference;
#     otherwise GC may cancel mid-flight. We retain refs in
#     `_BACKGROUND_REPORT_TASKS` and prune via add_done_callback.
_REPORT_LOCKS: dict[str, asyncio.Lock] = {}
_REPORT_LOCKS_GUARD: asyncio.Lock | None = None
_BACKGROUND_REPORT_TASKS: set[asyncio.Task[Any]] = set()


async def get_report_lock(sim_id: str) -> asyncio.Lock:
    """Return the per-sim asyncio.Lock for /report serialization.

    Lazy-creates the lock on first call. The guard lock is itself
    lazy-initialised so it binds to the running event loop, not import-time.
    """
    global _REPORT_LOCKS_GUARD
    if _REPORT_LOCKS_GUARD is None:
        _REPORT_LOCKS_GUARD = asyncio.Lock()
    async with _REPORT_LOCKS_GUARD:
        lock = _REPORT_LOCKS.get(sim_id)
        if lock is None:
            lock = asyncio.Lock()
            _REPORT_LOCKS[sim_id] = lock
        return lock


async def _safe_generate_report(sim_id: str) -> None:
    """Fire-and-forget end-of-sim auto-report.

    Acquires the same per-sim mutex used by POST /report so a user-click
    arriving mid-flight blocks on the lock and falls through to the cache
    on second-acquire (no duplicate thinking-model spend). Never raises —
    failures are logged with `log.exception` so an upstream error never
    affects the SSE `done` path or the simulation's persisted state.
    """
    # Local import — avoids any circular import risk if db ever grew an
    # import from swarm (it doesn't today).
    from .db import get_report as _db_get_report
    from .db import upsert_report as _db_upsert_report

    try:
        lock = await get_report_lock(sim_id)
        async with lock:
            # Skip if a report already exists (e.g. user pre-clicked, or a
            # prior auto-run succeeded). Keeps cost at +1 per sim, max.
            try:
                if _db_get_report(sim_id) is not None:
                    log.info("auto-report: cached row exists for %s — skipping", sim_id)
                    return
            except Exception:  # noqa: BLE001 — cache read failure shouldn't block generation
                log.exception("auto-report: cache check failed for %s", sim_id)

            payload = await generate_report(sim_id)
            try:
                _db_upsert_report(sim_id, payload, payload.get("model", GEMINI_ANALYSIS_MODEL))
                log.info("auto-report: persisted for %s", sim_id)
            except Exception:  # noqa: BLE001 — log + swallow; HTTP /report can retry
                log.exception("auto-report: upsert_report failed for %s", sim_id)
    except Exception:  # noqa: BLE001 — top-level guard, must never escape
        log.exception("auto-report: generation failed for %s", sim_id)


def schedule_auto_report(sim_id: str) -> asyncio.Task[None]:
    """Schedule a fire-and-forget auto-report for `sim_id`.

    Returns the Task so the caller can also retain a reference if it likes,
    but the function itself adds the task to the module-level
    `_BACKGROUND_REPORT_TASKS` set and prunes on completion — no caller
    bookkeeping required. Per Python 3.14 docs (May 2026), holding a strong
    reference is mandatory or the loop's weakref to the task may let GC
    cancel it mid-flight.
    """
    task = asyncio.create_task(_safe_generate_report(sim_id))
    _BACKGROUND_REPORT_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_REPORT_TASKS.discard)
    return task


async def generate_report(sim_id: str, *, client: Any | None = None) -> dict[str, Any]:
    """Generate a fresh full report for `sim_id` via the thinking model.

    Loads draft + audience + the cumulative thread from SQLite (latest
    round_events row). Builds a long structured prompt. ONE thinking-model
    call with `response_schema` matching §12. Returns the §12 wire shape:

        { simulation_id, draft, audience_label, rounds, post_count,
          generated_at, model, report }

    The caller (POST /report) is responsible for persisting via
    `db.upsert_report` and serving the wire shape. This function does NOT
    persist by itself — keeps swarm.py free of HTTP concerns.

    Raises:
        ReportSimNotFoundError — sim_id missing from DB.
        GeminiUnavailableError — thinking call failed (timeout / 5xx / auth).
        BudgetExceededError — per-call counter rejected (won't trigger here
            because the counter is dedicated to this single call).
    """
    # Local imports to avoid circular module load (db imports nothing from swarm).
    from datetime import datetime, timezone
    from .db import get_audience_unscoped, get_simulation_full_unscoped

    full = get_simulation_full_unscoped(sim_id)
    if full is None:
        raise ReportSimNotFoundError(sim_id)

    draft: str = full.get("draft") or ""
    posts: list[dict[str, Any]] = full.get("posts") or []
    rounds: int = int(full.get("rounds") or 0)

    # Recover audience metadata via the simulations row (we only have draft +
    # posts from get_simulation_full). Cheap second SELECT.
    # Ownership was already verified by the /report handler (or by the
    # auto-report fire-and-forget at end-of-sim, which inherits the SSE handler's
    # authorization). Use the unscoped helpers here.
    from .db import get_simulation_unscoped
    sim_row = get_simulation_unscoped(sim_id)
    # v4: hypothetical-mode sims weren't built against a user audience — route
    # them to the GENERAL_PUBLIC_AUDIENCE so the report renders "General public"
    # instead of "Unknown audience".
    mode = (sim_row or {}).get("mode") if sim_row else None
    if mode not in ("business", "hypothetical"):
        mode = "business"
    audience: dict[str, Any] | None = None
    if mode == "hypothetical":
        audience = GENERAL_PUBLIC_AUDIENCE
    elif sim_row and sim_row.get("audience_id"):
        audience = get_audience_unscoped(sim_row["audience_id"])
    audience_label = audience.get("name") if audience else "Unknown audience"
    audience_blurb = _audience_blurb(audience) if audience else "Unknown audience"

    if client is None:
        client = _make_client()

    # Dedicated per-call counter — /report is not part of a sim-bound budget.
    # The process-global semaphore (≤6) still gates concurrency.
    budget = BudgetCounter(max_calls=1)

    thread_block = _format_thread_for_report(posts)

    # P6 (realism overhaul): mode-aware framing. Hypothetical reports are
    # commentary on a *scenario* the public is weighing in on; business reports
    # are commentary on a *draft post* the author is about to publish. The
    # report schema is unchanged either way; only the prompt framing flips.
    if mode == "hypothetical":
        system = (
            "You are a senior public-opinion analyst. Read a 200-persona "
            "reaction simulation for a hypothetical scenario someone asked the "
            "public to weigh in on, and produce a structured, editorial-tone "
            "report on how the public would actually receive that scenario. "
            "Be honest, specific, and concrete — never generic, never "
            "encouraging-by-default. The 'verdict' field judges whether the "
            "scenario itself would land well (ship), land mixed (revise), or "
            "land badly (rethink) in the public eye. The 'rewrite_options' "
            "field offers alternative framings of the SCENARIO question (not "
            "of a draft post) that would surface clearer public reactions. "
            "Cite quotes verbatim from the thread when grounding claims. "
            "Output ONLY a single JSON object matching the schema. No prose, "
            "no markdown fences, no preamble."
        )
        input_header = "## SCENARIO\n"
    else:
        system = (
            "You are a senior PR / communications strategist. Read a 200-persona "
            "reaction simulation for a draft social post and produce a structured, "
            "editorial-tone report on how the public will receive it. Be honest, "
            "specific, and concrete — never generic, never encouraging-by-default. "
            "Cite quotes verbatim from the thread when grounding claims. "
            "Output ONLY a single JSON object matching the schema. No prose, no "
            "markdown fences, no preamble."
        )
        input_header = "## DRAFT POST\n"

    user = (
        f"{input_header}"
        f'"""\n{draft}\n"""\n\n'
        f"## AUDIENCE\n{audience_blurb}\n"
        f"(label: {audience_label})\n\n"
        f"## THREAD ({len(posts)} posts across {rounds} rounds)\n"
        f"Format: [round | post_id | parent | archetype handle sent=N] text\n\n"
        f"{thread_block}\n\n"
        "## TASK\n"
        "Return a JSON object with EXACTLY these keys:\n"
        "  executive_summary  — 3-5 sentences, the headline take.\n"
        "  verdict            — one of: ship | revise | rethink.\n"
        "  verdict_rationale  — 1-2 sentences explaining the verdict.\n"
        "  audience_reception — array of EXACTLY 6 entries, one per archetype "
        "(skeptic, enthusiast, curious, practitioner, pedant, lurker), each with "
        "{archetype, tone (positive|caution|danger|neutral), summary (2-3 sentences), "
        "representative_quote (≤200 chars, lifted verbatim from a real post by that "
        "archetype if any exists; empty string otherwise)}.\n"
        "  risk_vectors       — 2-4 items, each with "
        "{label (≤30 chars), severity (low|medium|high), detail (2-3 sentences)}.\n"
        "  rewrite_options    — 2-3 items, each with "
        "{label (≤30 chars, e.g. \"Softer framing\"), text (≤500 chars; the actual "
        "rewrite), rationale (1-2 sentences on why this addresses what)}.\n"
        "  comparable_discourse — 2-3 sentences referencing similar real-world "
        "reactions, OR an empty string if you decline.\n"
    )

    try:
        raw = await _call_gemini_thinking(
            system=system,
            user=user,
            schema=_REPORT_SCHEMA,
            budget=budget,
            client=client,
            temperature=0.55,
            max_tokens=8192,
            thinking_level="high",
            timeout=THINKING_CALL_TIMEOUT,
            raise_on_failure=True,
        )
    except (asyncio.TimeoutError, BudgetExceededError):
        raise
    except Exception as exc:  # noqa: BLE001 — single retry, then 502
        log.warning("generate_report first attempt failed: %r — retrying once", exc)
        try:
            raw = await _call_gemini_thinking(
                system=system,
                user=user,
                schema=_REPORT_SCHEMA,
                budget=BudgetCounter(max_calls=1),
                client=client,
                temperature=0.55,
                max_tokens=8192,
                thinking_level="high",
                timeout=THINKING_CALL_TIMEOUT,
                raise_on_failure=True,
            )
        except Exception as exc2:  # noqa: BLE001
            log.exception("generate_report retry failed: %r", exc2)
            raise GeminiUnavailableError(str(exc2)) from exc2

    if not raw or not raw.strip():
        # Treat empty body as upstream failure too — easier to debug than a
        # silent fallback report.
        raise GeminiUnavailableError("thinking model returned empty response")

    parsed_report = _parse_report(raw, draft)

    return {
        "simulation_id": sim_id,
        "draft": draft,
        "audience_label": audience_label,
        "rounds": rounds,
        "post_count": len(posts),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": GEMINI_ANALYSIS_MODEL,
        "report": parsed_report,
        # v4 (CONTRACTS §17): mode is surfaced in the wire shape and persisted
        # alongside the report payload. Legacy cached rows that pre-date this
        # field still validate because ReportResponse.mode defaults to "business".
        "mode": mode,
    }
