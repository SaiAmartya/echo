from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field

from .archetypes import Archetype


class PersonaScaffold(BaseModel):
    id: str
    handle: str
    archetype: Archetype
    audience_flag: str  # "target" | "public"
    seed_sentiment: float


class Reaction(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    sentiment: float = Field(ge=-1.0, le=1.0)
    replying_to_id: Optional[str] = None
    is_dogpile_starter: bool = False


class ReactionBatch(BaseModel):
    reactions: list[Reaction]


class AssignedReply(BaseModel):
    id: str
    persona_id: str
    persona_handle: str
    archetype: Archetype
    audience_flag: str
    text: str
    sentiment: float
    replying_to_id: Optional[str] = None
    is_dogpile_starter: bool = False
    round_num: int
    engagement: int = 0


class RoundEvent(BaseModel):
    """Streamed over SSE."""
    type: str  # "round_start" | "reply" | "round_complete" | "analysis_ready" | "error"
    round_num: Optional[int] = None
    reply: Optional[AssignedReply] = None
    archetype: Optional[Archetype] = None
    message: Optional[str] = None


class WorthReadingChain(BaseModel):
    root_reply_id: str
    rationale: str


class Analysis(BaseModel):
    headline: str
    suggested_rewrite: str
    chains: list[WorthReadingChain]


class AudienceProfile(BaseModel):
    demographics: str
    pain_points: list[str]
    vocabulary: list[str]
    recurring_opinions: list[str]
