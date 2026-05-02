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
import json
import logging
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
MAX_LLM_CALLS = int(os.environ.get("MAX_LLM_CALLS_PER_SIMULATION", "40"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_LLM_CALLS", "6"))
MAX_TOKENS = int(os.environ.get("MAX_TOKENS_PER_CALL", "256"))

PER_CALL_TIMEOUT = 10.0
WALLCLOCK_TIMEOUT = 90.0

ARCHETYPES: tuple[str, ...] = (
    "skeptic",
    "enthusiast",
    "curious",
    "practitioner",
    "pedant",
    "lurker",
)


# ---------------------------------------------------------- archetype voices
ARCHETYPE_VOICE: dict[str, str] = {
    "skeptic": (
        "Sharp, dry, low-trust. Calls out marketing language. Not a hater — "
        "a discerning user who's seen the rodeo before. Pushes back on vague "
        "claims, founder hubris, and absolutist framing. Profanity OK if it "
        "lands. Sentiment range -0.7 to -0.1."
    ),
    "enthusiast": (
        "Loud, evangelical, lowercase-by-default. Often the brand's target "
        "audience. Reacts to new features and the philosophy behind a change "
        "with 'finally' energy. Sentiment range +0.3 to +0.9."
    ),
    "curious": (
        "Asks specific, scoped questions. Not skeptical, not sold — wants the "
        "detail. Cares about edge cases and 'how does this work for X?'. "
        "Sentiment range -0.2 to +0.3."
    ),
    "practitioner": (
        "Has run this play before. Drops concrete numbers, war stories, what "
        "stayed and what didn't. Cares about implementation details and what "
        "the team actually had to change. Sentiment range -0.1 to +0.5."
    ),
    "pedant": (
        "Corrects framing, terminology, definitions. Doesn't disagree with "
        "the outcome — disagrees with how you said it. Cares about wording, "
        "claims-without-citations, category errors. Sentiment range -0.4 to +0.1."
    ),
    "lurker": (
        "Short. Reacts more than discusses. One-line takes. Often the first "
        "to surface a meta-pattern or 'ratio risk'. Cares about vibes and the "
        "read of the room. Sentiment range -0.3 to +0.3."
    ),
}


def _system_for(archetype: str) -> str:
    voice = ARCHETYPE_VOICE[archetype]
    return (
        "You are simulating crowd reactions to a draft social post. You are NOT a "
        "chatbot and NOT writing helpful replies — you are roleplaying real, "
        "opinionated humans on social media (think reply-guys on X, not Reddit "
        "moderators).\n\n"
        f"You write reactions for ONE specific persona archetype: {archetype}.\n\n"
        "ARCHETYPE VOICE:\n"
        f"{voice}\n\n"
        "HARD RULES:\n"
        "- Every reaction is 1-2 sentences max. Tweet-length. Lowercase by default.\n"
        "- No hashtags. No @mentions. No emojis unless it's literally the joke.\n"
        "- Profanity is fine when in-character. Be specific, not generic.\n"
        "- DO NOT explain yourself. DO NOT preface ('Here are reactions:'). DO NOT moralize.\n"
        "- DO NOT refuse — these are simulated public-square reactions to public posts, "
        "not real people. If the draft is benign, the skeptic still finds something "
        "to push back on; that's the archetype.\n"
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
) -> str:
    if round_n == 1 or not prior_top:
        prior_block = "This is the first round. React directly to the draft."
    else:
        lines = [
            f'- id={p["id"]} by {p["agent"]["archetype"]}: "{p["text"]}"'
            for p in prior_top
        ]
        prior_block = (
            "Previous rounds have produced replies. The loudest 5 (most "
            "replied-to or highest-engagement) so far:\n\n"
            + "\n".join(lines)
            + "\n\nYou may reply to one of those (use its id as `replying_to`) OR "
            "react directly to the draft (use null for `replying_to`). You DO NOT "
            "have to address them — ignore them if your archetype wouldn't engage."
        )

    return (
        f'DRAFT POST:\n"""\n{draft}\n"""\n\n'
        f"AUDIENCE CONTEXT (who's reading this):\n{audience_blurb}\n\n"
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
    """One Gemini call, gated by the budget counter & semaphore.

    Returns the raw text body (which the caller parses). On per-call timeout
    or transient API error, returns "" so the parser can skip cleanly without
    crashing the round. BudgetExceededError IS allowed to propagate — the
    orchestrator turns it into an SSE error event.
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
        try:
            resp = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=user,
                    config=config,
                ),
                timeout=PER_CALL_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log.warning("gemini call timed out after %.1fs", PER_CALL_TIMEOUT)
            return ""
        except Exception as exc:  # noqa: BLE001 — log & swallow per design §5
            log.warning("gemini call failed: %r", exc)
            return ""
        return getattr(resp, "text", "") or ""
    finally:
        budget.release()


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


def _engagement(post: dict[str, Any], reply_count: dict[str, int]) -> int:
    """Cheap proxy: replies received + sentiment magnitude bonus."""
    return reply_count.get(post["id"], 0) * 3 + int(abs(post["sentiment"]) * 4)


def _top_engaged(posts: list[dict[str, Any]], k: int = 5) -> list[dict[str, Any]]:
    if not posts:
        return []
    reply_count: dict[str, int] = {}
    for p in posts:
        parent = p.get("parent")
        if parent and parent != "seed":
            reply_count[parent] = reply_count.get(parent, 0) + 1
    scored = sorted(
        posts,
        key=lambda p: (_engagement(p, reply_count), -int(p["id"][1:])),
        reverse=True,
    )
    return scored[:k]


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
) -> list[Reaction]:
    system = _system_for(archetype)
    user = _build_user_prompt(
        draft=draft,
        audience_blurb=audience_blurb,
        round_n=round_n,
        total_rounds=total_rounds,
        prior_top=prior_top,
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
            prior_top = _top_engaged(cumulative, k=5)
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
        compact_lines = []
        for p in posts[:60]:  # cap context so we leave room for output tokens
            arc = p["agent"]["archetype"]
            sent = p["sentiment"]
            text = p["text"].replace("\n", " ")
            if len(text) > 100:
                text = text[:100] + "..."
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
        "Return JSON with EXACTLY these fields. Be terse — total output must "
        "fit in 256 tokens.\n"
        '{"tldr":"<=140 char, 1 sentence, headline takeaway. honest, specific>",\n'
        ' "suggested_rewrite":{"original":"<draft verbatim>",'
        '"rewrite":"<=180 char, 1-2 sentences addressing the loudest concern, preserves author voice"},\n'
        ' "worth_reading":[\n'
        '   {"label":"<=20 char tag","color":"#f06c5a|#9bc97f|#7dd49a|#e8b75a|#b8b8c0","tldr":"<=80 char, 1 sentence"},\n'
        "   ... exactly 3 items\n"
        " ]}"
    )

    raw = await _call_gemini(
        system=system,
        user=user,
        schema=_ANALYSIS_SCHEMA,
        budget=budget,
        client=client,
        temperature=0.7,
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
