from __future__ import annotations

import json
import os
from typing import Any

from .archetypes import Archetype
from .schemas import Analysis, AudienceProfile, AssignedReply, ReactionBatch
from .prompts import system_prompt_for, fewshots_for


class LLMError(Exception):
    pass


# Gemini-only. Round reactions on Flash-Lite (cheap, fast); final analysis on
# Flash 3 preview (better synthesis). Both controlled by env so the team can
# swap models without code edits.
GEMINI_REACTIONS_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
GEMINI_ANALYSIS_MODEL = os.environ.get("GEMINI_ANALYSIS_MODEL", "gemini-3-flash-preview")
GEMINI_MAX_OUTPUT_TOKENS = int(os.environ.get("MAX_TOKENS_PER_CALL", "256"))


def _build_user_prompt(
    archetype: Archetype,
    post: str,
    audience_profile: AudienceProfile | None,
    prev_round_top: list[AssignedReply],
    round_num: int,
    target_count: int,
) -> str:
    fewshots = "\n".join(f"- {ex}" for ex in fewshots_for(archetype))
    audience_block = ""
    if audience_profile:
        audience_block = (
            "AUDIENCE CONTEXT (the brand's target audience — keep voice plausible for this group):\n"
            f"- Demographics: {audience_profile.demographics}\n"
            f"- Pain points: {', '.join(audience_profile.pain_points)}\n"
            f"- Vocabulary: {', '.join(audience_profile.vocabulary)}\n"
            f"- Recurring opinions: {', '.join(audience_profile.recurring_opinions)}\n\n"
        )

    prev_block = ""
    if prev_round_top:
        from .prompts._shared import CROSS_ROUND_INSTRUCTION
        lines = [
            f'  [{r.id}] @{r.persona_handle} ({r.archetype.value}): "{r.text}"'
            for r in prev_round_top
        ]
        prev_block = (
            f"{CROSS_ROUND_INSTRUCTION}\n"
            "PREVIOUS ROUND'S LOUDEST REPLIES:\n" + "\n".join(lines) + "\n\n"
        )

    return (
        f"{audience_block}"
        f"FEW-SHOT EXAMPLES OF THIS ARCHETYPE'S VOICE:\n{fewshots}\n\n"
        f"THE POST:\n\"\"\"\n{post}\n\"\"\"\n\n"
        f"{prev_block}"
        f"This is round {round_num}. Generate exactly {target_count} in-character reactions "
        f"as a JSON object with key 'reactions' (an array). Each reaction has:\n"
        f"  - text (string, 1-500 chars)\n"
        f"  - sentiment (number, -1.0 to 1.0)\n"
        f"  - replying_to_id (string id from previous round, or null)\n"
        f"  - is_dogpile_starter (boolean)\n"
        f"Vary voice, length, stance, and punctuation across the batch. No two reactions should sound the same."
    )


# ---------- Schemas ----------

_REACTION_BATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "reactions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "sentiment": {"type": "number"},
                    "replying_to_id": {"type": "string", "nullable": True},
                    "is_dogpile_starter": {"type": "boolean"},
                },
                "required": ["text", "sentiment", "is_dogpile_starter"],
            },
        }
    },
    "required": ["reactions"],
}

_ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "suggested_rewrite": {"type": "string"},
        "chains": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "root_reply_id": {"type": "string"},
                    "rationale": {"type": "string"},
                },
                "required": ["root_reply_id", "rationale"],
            },
        },
    },
    "required": ["headline", "suggested_rewrite", "chains"],
}


# ---------- Provider: Gemini ----------

def _require_gemini_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise LLMError("GEMINI_API_KEY not set")
    return key


async def _call_gemini_json(
    system: str,
    user: str,
    *,
    model: str,
    schema: dict[str, Any],
    max_output_tokens: int | None = None,
    temperature: float = 0.95,
) -> dict[str, Any]:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=_require_gemini_key())
    cfg_kwargs: dict[str, Any] = {
        "system_instruction": system,
        "response_mime_type": "application/json",
        "response_schema": schema,
        "temperature": temperature,
    }
    if max_output_tokens is not None:
        cfg_kwargs["max_output_tokens"] = max_output_tokens

    try:
        resp = await client.aio.models.generate_content(
            model=model,
            contents=user,
            config=types.GenerateContentConfig(**cfg_kwargs),
        )
    except Exception as e:
        raise LLMError(f"gemini call failed ({model}): {e!r}") from e

    text = (resp.text or "").strip()
    if not text:
        raise LLMError(f"gemini returned empty response ({model})")
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"gemini returned invalid JSON ({model}): {e}") from e


# ---------- Public API: round reactions ----------

# Hook left in place for prompt tuning (e.g. swap a flat archetype to a
# different Gemini model). Values are model ids passed straight to Gemini.
HYBRID_OVERRIDES: dict[Archetype, str] = {
    # e.g. Archetype.LURKER: "gemini-3-flash-preview"
}


async def generate_reactions(
    archetype: Archetype,
    post: str,
    audience_profile: AudienceProfile | None,
    prev_round_top: list[AssignedReply],
    round_num: int,
    target_count: int = 12,
) -> ReactionBatch:
    system = system_prompt_for(archetype)
    user = _build_user_prompt(
        archetype, post, audience_profile, prev_round_top, round_num, target_count,
    )
    model = HYBRID_OVERRIDES.get(archetype, GEMINI_REACTIONS_MODEL)
    data = await _call_gemini_json(
        system, user,
        model=model,
        schema=_REACTION_BATCH_SCHEMA,
        max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS * 4,  # batch of reactions; budget needs headroom
    )
    return ReactionBatch.model_validate(data)


# ---------- Public API: analysis ----------

_ANALYSIS_SYSTEM = """You are an expert social-media strategist analyzing a swarm simulation.
You will receive a draft post and the full set of simulated reactions across multiple rounds.
Your job: distill the swarm's signal into a single actionable takeaway and a concrete rewrite.

Be specific. Reference real reactions. Do not hedge.
"""


async def generate_analysis(
    post: str,
    all_replies: list[AssignedReply],
    audience_profile: AudienceProfile | None,
) -> Analysis:
    audience_block = ""
    if audience_profile:
        audience_block = (
            f"Audience: {audience_profile.demographics}\n"
            f"Pain points: {', '.join(audience_profile.pain_points)}\n\n"
        )

    reply_lines = "\n".join(
        f'  [{r.id}] r{r.round_num} @{r.persona_handle} ({r.archetype.value}, {r.audience_flag}, sent={r.sentiment:.2f}): "{r.text}"'
        for r in all_replies
    )

    user = (
        f"{audience_block}"
        f"DRAFT POST:\n\"\"\"\n{post}\n\"\"\"\n\n"
        f"FULL SWARM REACTIONS ({len(all_replies)} total across all rounds):\n{reply_lines}\n\n"
        "Output JSON with keys:\n"
        "  - headline (string): one-sentence takeaway. Specific. No hedging.\n"
        "  - suggested_rewrite (string): a rewritten draft that addresses the swarm's biggest concern while keeping the post's intent.\n"
        "  - chains (array of exactly 3 objects, each with 'root_reply_id' and 'rationale'): the three reply chains a human reviewer should read first, with one-sentence rationale for each.\n"
    )

    data = await _call_gemini_json(
        _ANALYSIS_SYSTEM, user,
        model=GEMINI_ANALYSIS_MODEL,
        schema=_ANALYSIS_SCHEMA,
        max_output_tokens=2048,
        temperature=0.6,
    )
    return Analysis.model_validate(data)
