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
# Q1 (2026-05-02): rounds=15 needs 6 archetypes × 15 + 1 analysis + 1 report = 92 calls.
MAX_LLM_CALLS = int(os.environ.get("MAX_LLM_CALLS_PER_SIMULATION", "100"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_LLM_CALLS", "6"))
MAX_TOKENS = int(os.environ.get("MAX_TOKENS_PER_CALL", "256"))

PER_CALL_TIMEOUT = 10.0
# Thinking-model calls: longer ceiling (5-20s typical, occasional 30s+ on
# thinking_level=high). The inline analysis call (run_simulation) uses level=low
# so it stays under WALLCLOCK_TIMEOUT; /report uses level=high (no wallclock).
THINKING_CALL_TIMEOUT = 60.0
# Wallclock bumped 90 → 120s to leave headroom for the thinking-model analysis
# call after rounds complete. Per-archetype rounds still finish in ≈15s; the
# thinking analysis adds another ≈10–20s.
WALLCLOCK_TIMEOUT = 120.0

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
    "pattern; the full sentiment range is in play):\n\n"
    "Scenario: \"a major bank's CEO orchestrated a five-year emissions-data "
    "fraud that contributed to dozens of lung-disease deaths\"\n"
    "- skeptic: \"and the fine will be 0.3% of the profits they made. this is "
    "the system working as designed.\" (sentiment -0.85)\n"
    "- enthusiast: \"i don't know how to react to this with anything but "
    "disgust. who is enthusiastic about manslaughter-by-spreadsheet.\" "
    "(sentiment -0.9)\n"
    "- pedant: \"we're calling this 'fraud' but the legal term is criminal "
    "negligence; either way, dozens dead is the lede.\" (sentiment -0.7)\n\n"
    "Scenario: \"we redesigned our internal onboarding flow — 4 steps instead "
    "of 7\"\n"
    "- enthusiast: \"honestly thank you. the old one made me question my "
    "career choices.\" (sentiment +0.6)\n"
    "- skeptic: \"the question isn't 4 vs 7, it's whether the steps you cut "
    "were the ones that actually mattered.\" (sentiment 0.0)\n"
    "- lurker: \"good.\" (sentiment +0.3)\n\n"
    "Scenario: \"every city bans private cars from downtown\"\n"
    "- practitioner: \"ran the data for two european cities — emissions down "
    "30%, retail down 12% year one then back up by year three.\" (sentiment +0.1)\n"
    "- pedant: \"'cars' meaning private vehicles? delivery? buses? emergency? "
    "an entire policy stack hiding in one word.\" (sentiment -0.15)\n"
    "- enthusiast: \"every walkable city i've been to is the best part of that "
    "city. yes please.\" (sentiment +0.55)"
)


def _system_for(archetype: str) -> str:
    voice = ARCHETYPE_VOICE[archetype]
    return (
        "You are simulating crowd reactions to an input — sometimes a draft "
        "social post, sometimes a hypothetical scenario someone is asking the "
        "public to weigh in on. You are NOT a chatbot and NOT writing helpful "
        "replies — you are roleplaying real, opinionated humans on social media "
        "(think reply-guys on X, not Reddit moderators).\n\n"
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
) -> list[Reaction]:
    system = _system_for(archetype)
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
) -> AsyncIterator[dict[str, Any]]:
    """Async generator yielding SSE event dicts for one full simulation.

    Caller persists `event: round` payloads + the final analysis. On any
    terminal exception we yield an `event: error` with one of the
    CONTRACTS.md §5 error codes — never re-raise into the SSE handler.
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

    async def _inner() -> AsyncIterator[dict[str, Any]]:
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
                    )
                    for arc in ARCHETYPES
                ],
                return_exceptions=True,
            )
            for arc, res in zip(ARCHETYPES, results):
                if isinstance(res, BudgetExceededError):
                    raise res
                if isinstance(res, BaseException):
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
    user = (
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
            label_raw = item.get("label")
            color_raw = item.get("color")
            tldr_raw = item.get("tldr")
            label = label_raw if isinstance(label_raw, str) else fallback_labels[i % 3]
            color = color_raw if isinstance(color_raw, str) else fallback_colors[i % 3]
            tl = tldr_raw if isinstance(tldr_raw, str) else "See replies."
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
            label_raw = item.get("label")
            severity_raw = item.get("severity")
            detail_raw = item.get("detail")
            label = label_raw if isinstance(label_raw, str) else "Risk"
            severity = severity_raw if severity_raw in ("low", "medium", "high") else "medium"
            detail = detail_raw if isinstance(detail_raw, str) else ""
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
            label_raw = item.get("label")
            text_raw = item.get("text")
            rationale_raw = item.get("rationale")
            label = label_raw if isinstance(label_raw, str) else "Rewrite"
            text_v = text_raw if isinstance(text_raw, str) else ""
            rationale = rationale_raw if isinstance(rationale_raw, str) else ""
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
    from .db import get_audience, get_simulation_full

    full = get_simulation_full(sim_id)
    if full is None:
        raise ReportSimNotFoundError(sim_id)

    draft: str = full.get("draft") or ""
    posts: list[dict[str, Any]] = full.get("posts") or []
    rounds: int = int(full.get("rounds") or 0)

    # Recover audience metadata via the simulations row (we only have draft +
    # posts from get_simulation_full). Cheap second SELECT.
    from .db import get_simulation
    sim_row = get_simulation(sim_id)
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
        audience = get_audience(sim_row["audience_id"])
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
