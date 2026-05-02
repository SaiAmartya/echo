"""Offline smoke test — verifies persona/scattering/scoring without LLM calls.

Run: python -m api.engine._smoke_test
"""
from __future__ import annotations

import asyncio
import random
import uuid

from .archetypes import Archetype
from .personas import generate_personas, group_by_archetype
from .round_loop import _scatter, _score_engagement, _top_n_for_next_round
from .schemas import AssignedReply, Reaction


def test_personas() -> None:
    personas = generate_personas(seed=42)
    assert len(personas) == 200, f"expected 200 personas, got {len(personas)}"

    by_arch = group_by_archetype(personas)
    by_flag: dict[str, int] = {"public": 0, "target": 0}
    for p in personas:
        by_flag[p.audience_flag] += 1

    assert by_flag["public"] == 140, f"public count {by_flag['public']} != 140"
    assert by_flag["target"] == 60, f"target count {by_flag['target']} != 60"

    print(f"  personas: {len(personas)} total, {by_flag}")
    for a, plist in by_arch.items():
        print(f"    {a.value}: {len(plist)}")


def test_scatter_and_scoring() -> None:
    personas = generate_personas(seed=42)
    pool = group_by_archetype(personas)[Archetype.SKEPTIC]
    rng = random.Random(0)

    reactions = [
        Reaction(text="another wrapper", sentiment=-0.7, is_dogpile_starter=True),
        Reaction(text="vc bait", sentiment=-0.5),
        Reaction(text="ok this one's actually fine", sentiment=0.3),
    ]
    assigned = _scatter(reactions, pool, round_num=1, rng=rng)
    assert len(assigned) == 3
    for ar in assigned:
        assert ar.archetype == Archetype.SKEPTIC
        assert ar.engagement > 0

    top = _top_n_for_next_round(assigned, n=2)
    assert len(top) == 2
    assert top[0].engagement >= top[1].engagement
    print(f"  scatter+score ok; top reply engagement={top[0].engagement}")


async def main() -> None:
    print("== persona scaffold ==")
    test_personas()
    print("== scatter + scoring ==")
    test_scatter_and_scoring()
    print("\nall offline checks passed.")


if __name__ == "__main__":
    asyncio.run(main())
