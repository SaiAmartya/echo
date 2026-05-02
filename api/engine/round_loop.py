from __future__ import annotations

import asyncio
import random
import uuid
from typing import AsyncIterator

from .archetypes import Archetype, ARCHETYPE_MIX, REPLIES_PER_ARCHETYPE_PER_ROUND
from .llm import generate_reactions, LLMError
from .personas import generate_personas, group_by_archetype
from .schemas import (
    AssignedReply,
    AudienceProfile,
    PersonaScaffold,
    Reaction,
    RoundEvent,
)


def _target_count(archetype: Archetype, rng: random.Random) -> int:
    lo, hi = REPLIES_PER_ARCHETYPE_PER_ROUND
    weight = ARCHETYPE_MIX[archetype]
    base = int(round(lo + (hi - lo) * (weight / max(ARCHETYPE_MIX.values()))))
    return max(lo, min(hi, base + rng.randint(-2, 2)))


def _score_engagement(reply: AssignedReply) -> int:
    """Cheap heuristic for which replies to surface to next round.
    Real engagement is unknown — approximate with sentiment magnitude,
    dogpile-starter flag, and a small length penalty for mid-length punch."""
    score = abs(reply.sentiment) * 10
    if reply.is_dogpile_starter:
        score += 8
    length = len(reply.text)
    if 15 <= length <= 80:
        score += 3
    if reply.archetype in (Archetype.SKEPTIC, Archetype.PEDANT):
        score += 2
    return int(score)


def _scatter(
    reactions: list[Reaction],
    pool: list[PersonaScaffold],
    round_num: int,
    rng: random.Random,
) -> list[AssignedReply]:
    """Assign each reaction to a persona of the matching archetype."""
    if not pool:
        return []
    chosen = rng.sample(pool, k=min(len(reactions), len(pool)))
    if len(reactions) > len(pool):
        chosen += [rng.choice(pool) for _ in range(len(reactions) - len(pool))]

    assigned: list[AssignedReply] = []
    for reaction, persona in zip(reactions, chosen):
        engagement = 0
        ar = AssignedReply(
            id=uuid.uuid4().hex[:10],
            persona_id=persona.id,
            persona_handle=persona.handle,
            archetype=persona.archetype,
            audience_flag=persona.audience_flag,
            text=reaction.text,
            sentiment=reaction.sentiment,
            replying_to_id=reaction.replying_to_id,
            is_dogpile_starter=reaction.is_dogpile_starter,
            round_num=round_num,
            engagement=engagement,
        )
        ar.engagement = _score_engagement(ar)
        assigned.append(ar)
    return assigned


def _top_n_for_next_round(replies: list[AssignedReply], n: int = 5) -> list[AssignedReply]:
    return sorted(replies, key=lambda r: r.engagement, reverse=True)[:n]


async def _run_archetype(
    archetype: Archetype,
    post: str,
    audience_profile: AudienceProfile | None,
    prev_round_top: list[AssignedReply],
    round_num: int,
    pool: list[PersonaScaffold],
    rng: random.Random,
) -> list[AssignedReply]:
    target = _target_count(archetype, rng)
    try:
        batch = await generate_reactions(
            archetype=archetype,
            post=post,
            audience_profile=audience_profile,
            prev_round_top=prev_round_top,
            round_num=round_num,
            target_count=target,
        )
    except LLMError:
        return []

    return _scatter(batch.reactions, pool, round_num, rng)


async def run_simulation(
    post: str,
    rounds: int,
    audience_profile: AudienceProfile | None = None,
    seed: int | None = None,
) -> AsyncIterator[RoundEvent]:
    """Async generator that yields RoundEvents as the simulation progresses.

    The cross-round influence happens here: the top-N replies from round N-1 are
    fed into every archetype's prompt for round N. This is the swarm property —
    not 1-agent-per-LLM-call, but heterogeneous personas + cross-round context +
    emergent dogpile/consensus dynamics.
    """
    rng = random.Random(seed)
    personas = generate_personas(seed=seed)
    pools = group_by_archetype(personas)

    prev_round_top: list[AssignedReply] = []
    all_replies: list[AssignedReply] = []

    for round_num in range(1, rounds + 1):
        yield RoundEvent(type="round_start", round_num=round_num)

        # Fan out across all 6 archetypes in parallel.
        tasks = [
            _run_archetype(
                archetype=a,
                post=post,
                audience_profile=audience_profile,
                prev_round_top=prev_round_top,
                round_num=round_num,
                pool=pools[a],
                rng=random.Random(rng.random()),
            )
            for a in Archetype
        ]
        archetype_results = await asyncio.gather(*tasks, return_exceptions=False)

        round_replies: list[AssignedReply] = []
        for archetype, replies in zip(Archetype, archetype_results):
            for r in replies:
                yield RoundEvent(type="reply", round_num=round_num, reply=r, archetype=archetype)
            round_replies.extend(replies)

        all_replies.extend(round_replies)
        prev_round_top = _top_n_for_next_round(round_replies, n=5)

        yield RoundEvent(type="round_complete", round_num=round_num)

    yield RoundEvent(type="analysis_ready")
