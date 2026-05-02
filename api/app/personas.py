"""Persona scaffolding for swarm simulations.

Generates 200 personas per simulation with archetype distribution per
SWARM-DESIGN.md §3 and audience split per CONTRACTS.md §7 (70% public,
30% target). No LLM calls — fully deterministic given a seed.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

# Archetype distribution (SWARM-DESIGN §3, also surfaced in /seed UI).
DEFAULT_DISTRIBUTION: dict[str, float] = {
    "enthusiast": 0.28,
    "curious": 0.24,
    "practitioner": 0.18,
    "lurker": 0.12,
    "pedant": 0.10,
    "skeptic": 0.08,
}

# 70% public / 30% target audience split (CONTRACTS.md §7).
PUBLIC_SHARE = 0.70

# Static first-name pool — diverse, lowercase to match the social-feed vibe.
FIRST_NAMES: tuple[str, ...] = (
    "audrey", "marcus", "caleb", "jules", "tia", "samir", "priya", "nia",
    "evan", "rosa", "kai", "mei", "diego", "leila", "owen", "sasha",
    "isabel", "tomas", "rohan", "anika", "felix", "noor", "wren", "ezra",
    "yuki", "zoe", "ravi", "claire", "jonas", "amara", "mateo", "iris",
    "theo", "linnea", "santi", "nadia", "hugo", "saoirse", "callum", "aja",
)

# Static last-initial pool. 20 entries (per task description).
LAST_INITIALS: tuple[str, ...] = (
    "lin", "reid", "park", "verne", "k.", "pham", "tran", "ng", "ortiz", "khan",
    "fox", "ito", "rios", "vasquez", "okafor", "dubois", "haas", "brennan", "mori", "kowal",
)


@dataclass(slots=True, frozen=True)
class Persona:
    id: str          # e.g. "a1"
    name: str        # e.g. "audrey lin"
    handle: str      # e.g. "@audrey_lin"
    archetype: str   # one of the 6 archetype ids
    audience: str    # "public" | "target"


def _alloc_counts(total: int, dist: dict[str, float]) -> dict[str, int]:
    """Allocate `total` slots across archetypes, rounding to int and fixing residuals.

    Largest-remainder method, so the totals always sum to `total` and no
    archetype gets 0 unless its share is explicitly 0.
    """
    raw: dict[str, float] = {k: total * v for k, v in dist.items()}
    floors: dict[str, int] = {k: int(v) for k, v in raw.items()}
    used = sum(floors.values())
    remainders = sorted(
        ((k, raw[k] - floors[k]) for k in dist),
        key=lambda kv: kv[1],
        reverse=True,
    )
    leftover = total - used
    for i in range(leftover):
        floors[remainders[i % len(remainders)][0]] += 1
    return floors


def build_persona_pool(seed: int = 0, total: int = 200) -> list[Persona]:
    """Return `total` personas with archetype + audience distribution applied.

    Deterministic given `seed` so simulations are reproducible in tests.
    Names are drawn from the static pools above and salted with a numeric
    suffix when the pool is exhausted (avoids collisions at 200 personas).
    """
    rng = random.Random(seed)
    counts = _alloc_counts(total, DEFAULT_DISTRIBUTION)

    # Build a flat list of (archetype, audience) tuples.
    target_count = int(round(total * (1.0 - PUBLIC_SHARE)))
    audiences = ["target"] * target_count + ["public"] * (total - target_count)
    rng.shuffle(audiences)

    archetype_slots: list[str] = []
    for arc, n in counts.items():
        archetype_slots.extend([arc] * n)
    rng.shuffle(archetype_slots)

    # Generate name+handle. Use first×last combos; if we exhaust, salt with index.
    name_combos: list[tuple[str, str]] = [
        (fn, ln) for fn in FIRST_NAMES for ln in LAST_INITIALS
    ]
    rng.shuffle(name_combos)

    personas: list[Persona] = []
    for i in range(total):
        arc = archetype_slots[i]
        aud = audiences[i]
        if i < len(name_combos):
            fn, ln = name_combos[i]
            handle_seed = f"{fn}_{ln.replace('.', '').replace(' ', '')}"
        else:  # safety belt — won't trigger at total<=800
            fn, ln = name_combos[i % len(name_combos)]
            handle_seed = f"{fn}{i}"
        name = f"{fn} {ln}".strip()
        handle = f"@{handle_seed}"
        personas.append(
            Persona(
                id=f"a{i + 1}",
                name=name,
                handle=handle,
                archetype=arc,
                audience=aud,
            )
        )
    return personas


def index_by_archetype(personas: list[Persona]) -> dict[str, list[Persona]]:
    """Bucket personas by archetype for fast unrooted draws during a sim."""
    out: dict[str, list[Persona]] = {}
    for p in personas:
        out.setdefault(p.archetype, []).append(p)
    return out
