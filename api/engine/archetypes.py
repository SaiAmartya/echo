from enum import Enum


class Archetype(str, Enum):
    ENTHUSIAST = "enthusiast"
    PRACTITIONER = "practitioner"
    CURIOUS = "curious"
    LURKER = "lurker"
    PEDANT = "pedant"
    SKEPTIC = "skeptic"


ARCHETYPE_MIX: dict[Archetype, float] = {
    Archetype.ENTHUSIAST: 0.28,
    Archetype.PRACTITIONER: 0.18,
    Archetype.CURIOUS: 0.24,
    Archetype.LURKER: 0.12,
    Archetype.PEDANT: 0.10,
    Archetype.SKEPTIC: 0.08,
}

PUBLIC_MIX: dict[Archetype, float] = {
    Archetype.ENTHUSIAST: 0.15,
    Archetype.PRACTITIONER: 0.10,
    Archetype.CURIOUS: 0.30,
    Archetype.LURKER: 0.25,
    Archetype.PEDANT: 0.10,
    Archetype.SKEPTIC: 0.10,
}

TARGET_MIX: dict[Archetype, float] = {
    Archetype.ENTHUSIAST: 0.40,
    Archetype.PRACTITIONER: 0.30,
    Archetype.CURIOUS: 0.15,
    Archetype.LURKER: 0.05,
    Archetype.PEDANT: 0.05,
    Archetype.SKEPTIC: 0.05,
}

REPLIES_PER_ARCHETYPE_PER_ROUND = (8, 15)
