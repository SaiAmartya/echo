from __future__ import annotations

import json
import random
import uuid
from pathlib import Path

from .archetypes import Archetype
from .schemas import PersonaScaffold


HANDLE_PREFIXES = [
    "alex", "sam", "jordan", "riley", "casey", "morgan", "taylor", "quinn",
    "drew", "blake", "rowan", "sage", "emery", "finley", "harper", "kai",
    "luca", "milo", "nico", "oren", "remy", "theo", "vale", "wren", "zane",
    "ash", "bea", "cy", "dex", "eli", "fox", "gus", "ivy", "jax", "kit",
    "lex", "may", "nev", "ode", "pip", "quil", "ren", "sky", "tess", "uma",
    "vex", "wes", "xyl", "yui", "zev", "ami", "ben", "cleo", "dax", "ember",
]

HANDLE_SUFFIXES = [
    "_dev", "_eng", "_codes", "_irl", "_xyz", "_hq", "_io", "_writes",
    "_thinks", "_builds", "_ships", "_grinds", "_lurks", "_posts", "",
    "42", "99", "_real", "_official", "_again", "_etc",
]


def _make_handle(rng: random.Random) -> str:
    return rng.choice(HANDLE_PREFIXES) + rng.choice(HANDLE_SUFFIXES) + (
        str(rng.randint(0, 999)) if rng.random() < 0.3 else ""
    )


def _seed_sentiment_for(archetype: Archetype, rng: random.Random) -> float:
    base = {
        Archetype.ENTHUSIAST: 0.6,
        Archetype.PRACTITIONER: 0.15,
        Archetype.CURIOUS: 0.05,
        Archetype.LURKER: 0.0,
        Archetype.PEDANT: -0.1,
        Archetype.SKEPTIC: -0.45,
    }[archetype]
    return max(-1.0, min(1.0, base + rng.uniform(-0.25, 0.25)))


def _allocate(total: int, mix: dict[Archetype, float]) -> dict[Archetype, int]:
    counts = {a: int(round(total * w)) for a, w in mix.items()}
    drift = total - sum(counts.values())
    if drift:
        # Apply drift to the largest bucket so the total comes out exact.
        biggest = max(counts, key=lambda a: mix[a])
        counts[biggest] += drift
    return counts


def load_audience_mix(config_path: Path | str | None = None) -> dict:
    path = Path(config_path) if config_path else Path(__file__).parents[2] / "config" / "audience_mix.json"
    with open(path) as f:
        return json.load(f)


def generate_personas(
    seed: int | None = None,
    config_path: Path | str | None = None,
) -> list[PersonaScaffold]:
    """Programmatically scaffold N personas. No LLM calls."""
    rng = random.Random(seed)
    cfg = load_audience_mix(config_path)
    total = cfg["total_personas"]
    public_n = int(round(total * cfg["public_share"]))
    target_n = total - public_n

    public_mix = {Archetype(k): v for k, v in cfg["public_mix"].items()}
    target_mix = {Archetype(k): v for k, v in cfg["target_mix"].items()}

    public_counts = _allocate(public_n, public_mix)
    target_counts = _allocate(target_n, target_mix)

    personas: list[PersonaScaffold] = []
    for flag, counts in (("public", public_counts), ("target", target_counts)):
        for archetype, n in counts.items():
            for _ in range(n):
                personas.append(PersonaScaffold(
                    id=uuid.uuid4().hex[:12],
                    handle=_make_handle(rng),
                    archetype=archetype,
                    audience_flag=flag,
                    seed_sentiment=_seed_sentiment_for(archetype, rng),
                ))

    rng.shuffle(personas)
    return personas


def group_by_archetype(personas: list[PersonaScaffold]) -> dict[Archetype, list[PersonaScaffold]]:
    out: dict[Archetype, list[PersonaScaffold]] = {a: [] for a in Archetype}
    for p in personas:
        out[p.archetype].append(p)
    return out
