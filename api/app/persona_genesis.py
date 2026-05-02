"""Z1: Persona genesis for the v7 agentic swarm engine.

Generates a rich persona pool via ONE Gemini-3-Flash thinking call (level=low)
upfront per simulation. Each persona has a vivid bio, profession, and 1-3
hot-button issues — enough material for Z2's per-persona LLM agents to write
in ~50 distinguishable voices instead of the v6 engine's 6 archetype voices.

This module is purely ADDITIVE in Z1. The v6 engine continues to drive the
round loop after genesis runs — Z2 swaps the engine to consume these personas.

The output is persisted to the `personas` table (api/app/db.py). v7 replay
reads from disk; the genesis call NEVER re-runs (L22 — determinism via
persistence).

On any genesis failure (Gemini 5xx, auth, timeout, parse error, distribution
mismatch) we fall back to a deterministic shape derived from the existing
`personas.build_persona_pool` so the simulation can still complete. The
fallback personas have empty bios / null professions / empty hot-buttons —
Z2 prompts must tolerate this gracefully.
"""
from __future__ import annotations

import hashlib
import json
import logging
import random
import re
from typing import Any

from .personas import (
    DEFAULT_DISTRIBUTION,
    PUBLIC_SHARE,
    _alloc_counts,
    build_persona_pool,
)

# D1 (2026-05-02): voice cadence is the post-genesis, deterministic per-persona
# opener-structure tag. Source of truth lives at api/app/swarm.py:VOICE_CADENCES;
# we hard-code the same 7-tuple here to avoid a circular import (swarm.py
# imports this module from inside run_simulation, and we keep the dependency
# one-way at module-load time — see the deferred import in generate_persona_pool).
# Keep these two tuples in sync: any change to swarm.VOICE_CADENCES MUST mirror
# here, otherwise _assign_cadence will produce values _system_for_persona
# rejects (it falls back to "direct" on unknown cadences, which silently
# undoes the diversity push).
_VOICE_CADENCES: tuple[str, ...] = (
    "direct",
    "interrogative",
    "clipped",
    "narrative",
    "wry",
    "analytical",
    "emotional",
)


def _assign_cadence(persona_id: str) -> str:
    """Deterministic per-persona cadence assignment.

    Uses sha256 (NOT Python's built-in hash() — that's PYTHONHASHSEED-salted
    per-process and would break replay parity) on the persona_id, takes the
    first byte mod len(_VOICE_CADENCES). Same persona_id → same cadence on
    every run, every replay. Uniform-ish across the 7-cadence enum.

    Cadence is intentionally NOT an LLM-decided field: per the D-batch plan,
    asking genesis to pick cadence risks the LLM correlating it with archetype
    or profession and undoing the diversity push. Post-processing keeps it
    uncorrelated by construction.
    """
    digest = hashlib.sha256(persona_id.encode()).digest()
    return _VOICE_CADENCES[digest[0] % len(_VOICE_CADENCES)]

log = logging.getLogger("echo.persona_genesis")

# Hard archetype set — same source of truth as swarm.ARCHETYPES, but kept here
# at module-top to avoid a circular import at module-load time. (swarm.py
# imports this module via `from .persona_genesis import generate_persona_pool`
# inside run_simulation, so we keep our swarm imports deferred to function
# bodies.)
_ARCHETYPES: tuple[str, ...] = (
    "skeptic",
    "enthusiast",
    "curious",
    "practitioner",
    "pedant",
    "lurker",
)

# JSON schema (uppercase per Gemini API) for the genesis response.
# Gemini returns an ARRAY of persona objects in slot order — server validates
# count + archetype/audience distribution post-parse.
_PERSONA_SCHEMA: dict[str, Any] = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "name": {"type": "STRING"},
            "handle": {"type": "STRING"},
            "archetype": {"type": "STRING", "enum": list(_ARCHETYPES)},
            "audience": {"type": "STRING", "enum": ["target", "public"]},
            "bio": {"type": "STRING"},
            "profession": {"type": "STRING"},
            "hot_buttons": {
                "type": "ARRAY",
                "items": {"type": "STRING"},
            },
        },
        "required": [
            "name",
            "handle",
            "archetype",
            "audience",
            "bio",
            "profession",
            "hot_buttons",
        ],
    },
}


def _allocate_archetype_counts(
    audience: dict[str, Any],
    count: int,
) -> dict[str, int]:
    """Distribute `count` personas across archetypes per the audience shares.

    Falls back to DEFAULT_DISTRIBUTION when the audience dict doesn't carry
    valid per-archetype shares. Uses largest-remainder rounding so the totals
    sum to exactly `count` and every archetype gets at least 1 slot (the
    plan's diversity test requires count(DISTINCT archetype) = 6).
    """
    raw_archetypes = audience.get("archetypes") if isinstance(audience, dict) else None
    if isinstance(raw_archetypes, list) and raw_archetypes:
        # Shares from /seed are integer percentages summing to 100. Normalize
        # to fractions for _alloc_counts.
        dist: dict[str, float] = {}
        for entry in raw_archetypes:
            if not isinstance(entry, dict):
                continue
            arc = entry.get("id")
            share = entry.get("share")
            if arc in _ARCHETYPES and isinstance(share, (int, float)) and share > 0:
                dist[arc] = float(share) / 100.0
        # Defensive: if shares were malformed (sum 0 or missing arcs), bail to default.
        if not dist or abs(sum(dist.values()) - 1.0) > 0.05:
            dist = dict(DEFAULT_DISTRIBUTION)
    else:
        dist = dict(DEFAULT_DISTRIBUTION)

    # Ensure every archetype is represented in the dist before allocation,
    # otherwise _alloc_counts may give 0 to a missing arc and we'd fail the
    # "6 distinct archetypes" diversity gate.
    for arc in _ARCHETYPES:
        dist.setdefault(arc, 0.0)
    # Re-normalize after backfill so the dist sums to 1.0.
    total = sum(dist.values())
    if total <= 0:
        dist = dict(DEFAULT_DISTRIBUTION)
    else:
        dist = {k: v / total for k, v in dist.items()}

    counts = _alloc_counts(count, dist)
    # Guarantee every archetype has at least 1 (steal from the largest bucket).
    for arc in _ARCHETYPES:
        if counts.get(arc, 0) == 0:
            donor = max(counts, key=counts.get)
            if counts[donor] > 1:
                counts[donor] -= 1
                counts[arc] = 1
    return counts


def _allocate_audience_counts(count: int) -> tuple[int, int]:
    """Return (target_count, public_count). 30% target / 70% public per
    personas.PUBLIC_SHARE — the same split the v1-v6 engine uses."""
    target = int(round(count * (1.0 - PUBLIC_SHARE)))
    public = count - target
    return target, public


def _slot_assignments(
    audience: dict[str, Any],
    *,
    count: int,
    seed: int,
) -> list[tuple[str, str]]:
    """Build a deterministic ordered list of (archetype, audience) slots.

    The slot list is fed into the genesis prompt verbatim so the LLM produces
    one persona per slot in order — guaranteeing exact distribution and
    sidestepping LLM "almost-right" counting drift.
    """
    arc_counts = _allocate_archetype_counts(audience, count)
    target_count, _public_count = _allocate_audience_counts(count)

    audiences = ["target"] * target_count + ["public"] * (count - target_count)
    rng = random.Random(seed)
    rng.shuffle(audiences)

    archetype_slots: list[str] = []
    for arc, n in arc_counts.items():
        archetype_slots.extend([arc] * n)
    rng.shuffle(archetype_slots)

    return list(zip(archetype_slots, audiences))


def _format_slot_lines(slots: list[tuple[str, str]]) -> str:
    """Compact slot block for the user prompt. One line per slot: index + tags."""
    lines: list[str] = []
    for i, (arc, aud) in enumerate(slots, start=1):
        lines.append(f"{i:>3}. archetype={arc}, audience={aud}")
    return "\n".join(lines)


def _archetype_count_summary(slots: list[tuple[str, str]]) -> str:
    """Plain-English summary of archetype counts (for the prompt header)."""
    counts: dict[str, int] = {arc: 0 for arc in _ARCHETYPES}
    for arc, _aud in slots:
        counts[arc] += 1
    return ", ".join(f"{arc}={n}" for arc, n in counts.items() if n > 0)


def _build_system_prompt(count: int) -> str:
    """The genesis system prompt — diversity mandate is the headline.

    The whole reason we're paying for a thinking call is to escape the v6
    "50 versions of the same person" failure mode. The mandate makes the
    diversity instruction load-bearing rather than decorative.
    """
    return (
        f"You generate a roster of {count} distinct social-media personas for "
        "a public-discourse simulation. Each persona is a believable real-feeling "
        "human with a vivid bio, profession, and 1-3 hot-button issues they "
        "actually care about.\n\n"
        f"DIVERSITY MANDATE — the {count} personas MUST read as {count} different "
        f"humans, NOT {count} versions of the same person. Different vocabularies, "
        "different framings, different concerns, different life situations.\n\n"
        "Distribute professions BROADLY — do NOT clump on tech. Hit at least:\n"
        "  - tech (~15%): engineers, designers, PMs, junior devs, IT support\n"
        "  - trades (~12%): plumbers, electricians, mechanics, contractors, HVAC\n"
        "  - healthcare (~10%): nurses, paramedics, dental hygienists, pharmacists\n"
        "  - retail/service (~12%): baristas, cashiers, line cooks, delivery, hairstylists\n"
        "  - education (~8%): teachers, librarians, school counselors, tutors\n"
        "  - creative (~8%): musicians, freelance writers, small-shop artists, photographers\n"
        "  - white-collar (~12%): accountants, paralegals, insurance reps, HR, real estate\n"
        "  - students (~8%): undergrads, grad students, vocational, returning adult learners\n"
        "  - retirees (~8%): former teachers, ex-military, retired nurses, ex-trades\n"
        "  - other (~7%): rideshare/gig, stay-at-home parents, between-jobs, small-farm\n\n"
        "Geography: ~50% US (mix urban/suburban/rural — Indianapolis, rural Iowa, "
        "Bay Area, Atlanta, Phoenix, Cleveland, rural Maine), ~20% UK/EU (Manchester, "
        "Berlin, Madrid, Lyon, Dublin), ~15% Asia-Pacific (Bangalore, Manila, Sydney, "
        "Seoul, Auckland), ~15% rest of world (São Paulo, Lagos, Toronto, Mexico City, "
        "Cape Town).\n\n"
        "Age bands: gen-z ~15%, millennial ~30%, gen-x ~30%, boomer/older ~25%.\n\n"
        "BIOS MUST BE VIVID AND SPECIFIC. Bad vs good:\n"
        "  BAD:  \"skeptical millennial who works in tech\"\n"
        "  GOOD: \"former math teacher, now runs a small Etsy shop selling hand-stitched "
        "pet bandanas, lives in Indianapolis, mid-40s, dry-witted\"\n"
        "  GOOD: \"third-shift ER nurse in Cleveland, 31, two kids, sharp tongue, votes "
        "but distrusts both parties\"\n"
        "  GOOD: \"retired postal worker outside Lyon, mid-60s, gardens obsessively, "
        "writes long earnest replies\"\n"
        "60-180 chars per bio. Plain prose, lowercase, no quotes inside the bio.\n\n"
        "HOT-BUTTONS: 1-3 specific issues per persona. Mix center/left/right but NEVER "
        "caricature — these are plausible humans, not partisan props. Ground each in "
        "something tangible they'd encounter: \"rising rent in their city\", \"AI taking "
        "entry-level jobs\", \"school zoning fights\", \"cost of insulin\", \"EV reliability\", "
        "\"youth sports getting too expensive\", \"book bans\", \"local zoning meetings\".\n\n"
        "VOICE VARIATION: bios should hint at HOW each person writes — terse vs wordy, "
        "ironic vs earnest, jargon-heavy vs plain, hopeful vs cynical.\n\n"
        "Names: lowercase, first + last (e.g. \"audrey lin\", \"diego ramirez\", \"yuki tanaka\"). "
        "Mix first names from many cultures. Handles match the name with underscore "
        "(e.g. \"@audrey_lin\"). Names MUST be unique across the whole roster.\n\n"
        "Output ONLY a JSON array. No prose, no markdown fences, no commentary."
    )


def _build_user_prompt(
    *,
    audience: dict[str, Any],
    slots: list[tuple[str, str]],
    count: int,
) -> str:
    """User prompt — slot list + audience context."""
    audience_name = audience.get("name") or "general public"
    audience_size = audience.get("size") or 0
    arc_summary = _archetype_count_summary(slots)
    slot_lines = _format_slot_lines(slots)

    return (
        f"AUDIENCE CONTEXT: {audience_name} — {audience_size:,} people total. "
        f"Archetype counts in this roster: {arc_summary}.\n\n"
        f"Generate exactly {count} personas, ONE per slot below. Each slot fixes "
        "the persona's archetype and audience tag (target = part of the named "
        "audience, public = general bystander). Fill in the rest from your "
        "diversity mandate.\n\n"
        f"SLOTS:\n{slot_lines}\n\n"
        f"Return a JSON ARRAY of EXACTLY {count} objects, in slot order (slot 1 "
        "first, slot N last). Each object MUST include all 7 fields:\n"
        "  - name: lowercase \"first last\"\n"
        "  - handle: \"@first_last\" matching the name\n"
        "  - archetype: exactly the slot's archetype tag\n"
        "  - audience: exactly the slot's audience tag\n"
        "  - bio: 60-180 char vivid descriptor\n"
        "  - profession: short concise phrase\n"
        "  - hot_buttons: array of 1-3 short issue strings\n\n"
        f"Reminder: make these {count} sound like {count} DIFFERENT HUMANS — "
        "different vocabularies, framings, hot-buttons, life situations. "
        "Avoid the trap of generating 'tech-skeptical millennial' five times "
        "with different names."
    )


# --------------------------------------------------------------- parse + validate
def _coerce_persona(
    raw: Any,
    *,
    fallback_arc: str,
    fallback_aud: str,
    index: int,
) -> dict[str, Any] | None:
    """Validate & normalize one LLM persona object. Returns None on hard fail."""
    if not isinstance(raw, dict):
        return None

    name = raw.get("name")
    handle = raw.get("handle")
    archetype = raw.get("archetype")
    audience = raw.get("audience")
    bio = raw.get("bio")
    profession = raw.get("profession")
    hot_buttons = raw.get("hot_buttons")

    # Coerce + sanity-check primitives. The schema enforces types but the SDK
    # has been observed to occasionally surface malformed structures on slow
    # thinking-mode responses — defense in depth.
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(handle, str) or not handle.strip():
        # Synthesize from name if missing.
        handle = "@" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or f"@p{index}"
    if not isinstance(archetype, str) or archetype not in _ARCHETYPES:
        archetype = fallback_arc
    if audience not in ("target", "public"):
        audience = fallback_aud
    if not isinstance(bio, str):
        bio = ""
    bio = bio.strip()[:200]  # hard cap for DB sanity
    if not isinstance(profession, str):
        profession = ""
    profession = profession.strip()[:80] or None
    if not isinstance(hot_buttons, list):
        hot_buttons = []
    cleaned_hb: list[str] = []
    for hb in hot_buttons[:3]:
        if isinstance(hb, str) and hb.strip():
            cleaned_hb.append(hb.strip()[:80])

    name_clean = name.strip().lower()[:60]
    handle_clean = handle.strip().lower()[:60]
    if not handle_clean.startswith("@"):
        handle_clean = "@" + handle_clean.lstrip("@")

    return {
        "name": name_clean,
        "handle": handle_clean,
        "archetype": archetype,
        "audience": audience,
        "bio": bio,
        "profession": profession,
        "hot_buttons": cleaned_hb,
    }


def _validate_pool(
    raw_items: Any,
    slots: list[tuple[str, str]],
    *,
    sim_id: str,
) -> list[dict[str, Any]] | None:
    """Validate the LLM-returned array against the slot list.

    Returns the validated list (with persona_id stamped), or None if the
    output is unrecoverably mismatched (caller falls back to deterministic).
    Mild distribution drift is tolerated; we re-stamp archetype/audience from
    the slot if the LLM swapped them but kept the count.
    """
    if not isinstance(raw_items, list):
        return None
    if len(raw_items) != len(slots):
        # Hard fail on count mismatch — Z2 needs exactly `count` personas.
        log.warning(
            "genesis: count mismatch (got %d, want %d) — falling back",
            len(raw_items),
            len(slots),
        )
        return None

    seen_names: set[str] = set()
    seen_handles: set[str] = set()
    out: list[dict[str, Any]] = []

    for i, (raw, (slot_arc, slot_aud)) in enumerate(zip(raw_items, slots)):
        coerced = _coerce_persona(
            raw, fallback_arc=slot_arc, fallback_aud=slot_aud, index=i + 1
        )
        if coerced is None:
            log.warning("genesis: slot %d malformed — falling back", i + 1)
            return None
        # Slot tags are authoritative — re-stamp even if the LLM agreed, so
        # we never drift from the requested distribution.
        coerced["archetype"] = slot_arc
        coerced["audience"] = slot_aud

        # Dedupe names + handles (LLM occasionally repeats).
        name = coerced["name"]
        handle = coerced["handle"]
        suffix = 0
        while name in seen_names:
            suffix += 1
            name = f"{coerced['name']} {suffix}"
        seen_names.add(name)
        coerced["name"] = name

        suffix = 0
        base_handle = handle
        while handle in seen_handles:
            suffix += 1
            handle = f"{base_handle}{suffix}"
        seen_handles.add(handle)
        coerced["handle"] = handle

        coerced["persona_id"] = f"a{i + 1}"
        # D1: deterministic post-genesis cadence assignment. Stamp AFTER
        # persona_id is finalized so the sha256 derivation is stable across
        # runs/replays. See _assign_cadence docstring for why this isn't an
        # LLM-decided field.
        coerced["voice_cadence"] = _assign_cadence(coerced["persona_id"])
        out.append(coerced)

    return out


# --------------------------------------------------------------- fallback
def _fallback_pool(
    *,
    audience: dict[str, Any],
    sim_id: str,
    count: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Deterministic fallback if the genesis call fails.

    Reuses `personas.build_persona_pool` (the v6 path) for name/handle/
    archetype/audience, then stamps empty bio/profession/hot_buttons. Z2's
    per-persona prompts must tolerate this gracefully; the simulation still
    completes, it just lacks the rich-bio diversity boost.
    """
    log.warning("genesis: using deterministic fallback for sim=%s", sim_id)
    base = build_persona_pool(seed=seed, total=count)
    # build_persona_pool's distribution uses DEFAULT_DISTRIBUTION (not the
    # /seed-supplied audience). For Z1 fallback that's acceptable — the v6
    # engine isn't consuming these personas yet, and the verification gate
    # only asserts count/distinct-archetypes, both of which hold.
    out: list[dict[str, Any]] = []
    for i, p in enumerate(base):
        out.append(
            {
                "persona_id": p.id,  # already "a1", "a2", ...
                "name": p.name,
                "handle": p.handle,
                "archetype": p.archetype,
                "audience": p.audience,
                "bio": "",
                "profession": None,
                "hot_buttons": [],
                # D1: cadence assigned even on the deterministic fallback so
                # the wire shape is uniform across paths and v7 sims that
                # took the fallback still get cadence-diversified openers.
                "voice_cadence": _assign_cadence(p.id),
            }
        )
    return out


# --------------------------------------------------------------- public API
async def generate_persona_pool(
    *,
    audience: dict[str, Any],
    sim_id: str,
    count: int,
    client: Any,
    budget: Any,
) -> list[dict[str, Any]]:
    """Generate `count` rich personas via ONE Gemini-3-Flash thinking call.

    Args:
      audience: same shape as everywhere else in this codebase
        ({id, name, size, archetypes:[{id,name,share},...]}). Used to derive
        archetype distribution and the audience-context blurb.
      sim_id: stable identifier; used to seed slot shuffling so the same
        sim_id produces the same slot order on retry. (LLM output is still
        non-deterministic — that's why we persist the result.)
      count: number of personas. Caller (main.py) clamps to [30, 100].
      client: Gemini client (passed through to _call_gemini_thinking).
      budget: BudgetCounter (genesis call counts as 1).

    Returns:
      list[dict] with keys: persona_id, name, handle, archetype, audience,
      bio, profession (str | None), hot_buttons (list[str]).

    Failure modes (all → deterministic fallback, sim still completes):
      - Gemini auth / 5xx / timeout
      - JSON parse failure
      - Count mismatch between request and response
      - Per-slot validation failure
      BudgetExceededError propagates — the caller's wallclock-cap layer
      maps it to the SSE error event.
    """
    # Deferred import — swarm.py imports this module from inside run_simulation,
    # so we keep the dependency one-way at module-load time.
    from .swarm import (  # noqa: WPS433 — intentional deferred import
        BudgetExceededError,
        _call_gemini_thinking,
    )

    if count < 1:
        return []

    # Stable shuffle seed from sim_id (independent of PYTHONHASHSEED).
    seed = int.from_bytes(sim_id.encode(), "little") & 0xFFFFFFFF

    slots = _slot_assignments(audience, count=count, seed=seed)
    system = _build_system_prompt(count)
    user = _build_user_prompt(audience=audience, slots=slots, count=count)

    log.info(
        "persona genesis: sim=%s count=%d archetype_split=%s",
        sim_id,
        count,
        _archetype_count_summary(slots),
    )

    try:
        # Output budget: ~150 tokens/persona at the verbose end, 80 at the
        # tight end. 200 × count gives 6000-20000 — well within Gemini-3's
        # output ceiling, and slack against verbose responses.
        max_tokens = max(4096, count * 220)
        raw = await _call_gemini_thinking(
            system=system,
            user=user,
            schema=_PERSONA_SCHEMA,
            budget=budget,
            client=client,
            temperature=0.85,       # high — we want voice variation
            max_tokens=max_tokens,
            thinking_level="low",   # genesis runs synchronously before round 1
            timeout=60.0,           # match THINKING_CALL_TIMEOUT
            raise_on_failure=False,  # swallow → we'll fall back below
        )
    except BudgetExceededError:
        # Per-sim budget exhausted before genesis even ran. Don't swallow —
        # the caller's error-handling layer maps this to the SSE error event.
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("genesis: gemini call crashed for sim=%s: %r", sim_id, exc)
        return _fallback_pool(audience=audience, sim_id=sim_id, count=count, seed=seed)

    if not raw:
        log.warning("genesis: empty response for sim=%s", sim_id)
        return _fallback_pool(audience=audience, sim_id=sim_id, count=count, seed=seed)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        # Try one repair pass: pull the outermost [...] if there's stray
        # prose around it (rare with response_schema, but seen on truncation).
        m = re.search(r"\[.*\]", raw, flags=re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except json.JSONDecodeError:
                log.warning("genesis: parse failed for sim=%s: %r", sim_id, exc)
                return _fallback_pool(audience=audience, sim_id=sim_id, count=count, seed=seed)
        else:
            log.warning("genesis: parse failed for sim=%s: %r", sim_id, exc)
            return _fallback_pool(audience=audience, sim_id=sim_id, count=count, seed=seed)

    validated = _validate_pool(parsed, slots, sim_id=sim_id)
    if validated is None:
        return _fallback_pool(audience=audience, sim_id=sim_id, count=count, seed=seed)

    log.info(
        "persona genesis: sim=%s OK — %d personas, %d distinct professions",
        sim_id,
        len(validated),
        len({p["profession"] for p in validated if p.get("profession")}),
    )
    return validated
