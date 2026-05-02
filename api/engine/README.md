# Echo Swarm Engine

Person C — the round-loop core. Imported by Person B's FastAPI app.

## Why this is swarm intelligence, not a GPT wrapper

Three properties — all present in `round_loop.run_simulation`:

1. **Heterogeneous personas.** Each round fans out across 6 archetypes (Enthusiast / Practitioner / Curious / Lurker / Pedant / Skeptic), each with its own system prompt and its own few-shot voice. Same input, different reaction distributions.
2. **Cross-round influence.** Round N's prompt receives the top-N engaged replies from round N-1 as context (`prev_round_top` in `run_simulation`). Round 2 personas literally see and react to round 1 personas. This is the swarm property — not the LLM call count.
3. **Emergent dynamics.** Dogpiles, consensus formation, and minority opinions emerge from the round-over-round dynamics, not from any single prompt. The `_score_engagement` heuristic decides which replies propagate, so loud takes pull more replies in their direction in later rounds.

OASIS (CAMEL-AI) and Smallville-style behavioral sims use the same trick at higher scale: clever batching + shared context, not 1-agent-per-process.

## Cost trick

200 personas × 5 rounds is 1,000 naive LLM calls. We instead batch by archetype: 6 archetype calls × 5 rounds = **30 LLM calls per simulation**. Same apparent fidelity, ~33× cheaper. At Gemini 2.5 Flash-Lite rates that's ~$0.005 round + ~$0.015 analysis = **~$0.02/sim**.

## Layout

```
api/engine/
  archetypes.py        # Archetype enum, mix constants
  schemas.py           # Pydantic models (PersonaScaffold, Reaction, AssignedReply, RoundEvent, Analysis)
  personas.py          # 200-persona scaffold generator (no LLM)
  llm.py               # Provider abstraction: Gemini -> Groq fallback; Anthropic for analysis
  round_loop.py        # run_simulation() async generator — the public entrypoint
  prompts/
    _shared.py         # VOICE_RULES, CROSS_ROUND_INSTRUCTION
    enthusiast.py      # SYSTEM + FEWSHOTS per archetype
    practitioner.py
    curious.py
    lurker.py
    pedant.py
    skeptic.py
config/audience_mix.json  # 70/30 public/target ratio + per-flag archetype mix
```

## Public API (for Person B)

```python
from api.engine.round_loop import run_simulation
from api.engine.llm import generate_analysis
from api.engine.schemas import AudienceProfile

async for event in run_simulation(
    post="your draft here",
    rounds=5,
    audience_profile=AudienceProfile(...),  # from Person D's /seed
    seed=42,
):
    # event.type in {"round_start", "reply", "round_complete", "analysis_ready", "error"}
    # forward to SSE
    ...

# After analysis_ready:
analysis = await generate_analysis(post, all_replies, audience_profile)
```

## Env vars

- `GEMINI_API_KEY` — primary (Gemini 2.5 Flash-Lite)
- `GROQ_API_KEY` — fallback (Llama 3.3 70B)
- `ANTHROPIC_API_KEY` — analysis call (Claude Sonnet 4.6)

## Hybrid-routing hook

If a specific archetype keeps coming out flat in QA, add it to `HYBRID_OVERRIDES` in `llm.py`:

```python
HYBRID_OVERRIDES = {Archetype.LURKER: "sonnet"}
```

That archetype alone routes to Sonnet 4.6 while the rest stay on Flash-Lite.

## Tuning loop

1. Run all 3 pre-loaded brands.
2. Eyeball each archetype's replies. Are they generic? Do they sound the same as each other?
3. Edit the `SYSTEM` prompt in the offending `prompts/<archetype>.py`. Add or replace `FEWSHOTS` with sharper real-tweet-style examples.
4. Re-run. Repeat until rounds 3+ visibly differ from round 1 (dogpile/consensus).
