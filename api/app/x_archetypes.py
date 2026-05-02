from __future__ import annotations

import re
from typing import Any

ARCHETYPE_IDS = ["skeptic", "enthusiast", "curious", "practitioner", "pedant", "lurker"]
DISPLAY_NAMES = {
    "skeptic": "Skeptics",
    "enthusiast": "Enthusiasts",
    "curious": "Curious",
    "practitioner": "Practitioners",
    "pedant": "Pedants",
    "lurker": "Lurkers",
}

_DEFAULT: dict[str, int] = {
    "skeptic": 20,
    "enthusiast": 20,
    "curious": 18,
    "practitioner": 17,
    "pedant": 12,
    "lurker": 13,
}

_RE_PRACTITIONER = re.compile(
    r"engineer|founder|ceo|cto|pm|product|designer|dev|developer|scientist|researcher|analyst",
    re.IGNORECASE,
)
_RE_ENTHUSIAST = re.compile(
    r"ai|web3|builder|🚀|crypto|nft|startup|hustle|grind",
    re.IGNORECASE,
)
_RE_CURIOUS = re.compile(
    r"learning|exploring|student|newbie|curious|aspiring|enthusiast",
    re.IGNORECASE,
)


def _classify(user: dict[str, Any]) -> str:
    metrics = user.get("public_metrics") or {}
    followers_count = metrics.get("followers_count", 0) or 0
    verified = user.get("verified") or False
    desc = user.get("description") or ""

    if verified or followers_count > 5000:
        return "pedant"
    if _RE_PRACTITIONER.search(desc):
        return "practitioner"
    if _RE_ENTHUSIAST.search(desc):
        return "enthusiast"
    if _RE_CURIOUS.search(desc):
        return "curious"
    if not desc or len(desc) < 20:
        return "lurker"
    return "skeptic"


def _largest_remainder(raw: dict[str, float]) -> dict[str, int]:
    floors = {k: int(v) for k, v in raw.items()}
    used = sum(floors.values())
    leftover = 100 - used
    remainders = sorted(
        ((k, raw[k] - floors[k]) for k in raw),
        key=lambda kv: kv[1],
        reverse=True,
    )
    for i in range(leftover):
        floors[remainders[i % len(remainders)][0]] += 1
    return floors


def infer_archetypes(
    followers: list[dict[str, Any]],
    following: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    all_users = followers + following
    if not all_users:
        return [{"id": k, "name": DISPLAY_NAMES[k], "share": _DEFAULT[k]} for k in ARCHETYPE_IDS]

    counts: dict[str, int] = {k: 0 for k in ARCHETYPE_IDS}
    for user in all_users:
        counts[_classify(user)] += 1

    total = len(all_users)
    raw = {k: (counts[k] / total) * 100 for k in ARCHETYPE_IDS}
    shares = _largest_remainder(raw)

    return [{"id": k, "name": DISPLAY_NAMES[k], "share": shares[k]} for k in ARCHETYPE_IDS]
