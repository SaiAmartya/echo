from __future__ import annotations

from ..archetypes import Archetype
from . import enthusiast, practitioner, curious, lurker, pedant, skeptic


PROMPTS = {
    Archetype.ENTHUSIAST: enthusiast,
    Archetype.PRACTITIONER: practitioner,
    Archetype.CURIOUS: curious,
    Archetype.LURKER: lurker,
    Archetype.PEDANT: pedant,
    Archetype.SKEPTIC: skeptic,
}


def system_prompt_for(archetype: Archetype) -> str:
    return PROMPTS[archetype].SYSTEM


def fewshots_for(archetype: Archetype) -> list[str]:
    return PROMPTS[archetype].FEWSHOTS
