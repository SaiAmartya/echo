# SWARM-DESIGN.md — Echo swarm engine

**Audience:** the backend engineer implementing Phase B. You know Python + FastAPI but maybe not prompt engineering. This doc tells you *exactly* what to build, what to send Gemini, what to do with the response, and how to keep the bill at zero.

**Status:** LOCKED at v1. Wire format in `.team/CONTRACTS.md` is the FE↔BE source of truth.

---

## 1. Goal & non-goals

### Goal

Given a draft social post + an "audience profile" + a round count `R∈[3,20]`, run a multi-round swarm simulation that streams 200-persona reactions to the frontend in real time and ends with a single aggregated takeaway + suggested rewrite + 3 "worth reading" reply chains.

The output must *feel* like 200 distinct people reacting, with cross-influence (round N replies reference round N-1 replies), dogpiles, and emergent consensus.

### Non-goals

- **No 1-call-per-persona fan-out.** That's $0.20+ and 1000+ requests per sim. We're not doing that.
- **No real-time bidirectional comms.** SSE one-way only.
- **No cross-simulation persona memory.** Each sim is self-contained. Persona state lives in a Python dict for the duration of the request, then dies.
- **No graph DB / vector DB.** SQLite + in-process dicts.
- **No model-routing magic.** All round calls and the analysis call go to `gemini-2.5-flash-lite`. (Action plan mentions Sonnet for analysis; we're keeping it Flash-Lite to stay inside one provider + one budget. If quality is bad, swap *only* the analysis call later.)
- **No silent failure on budget breach.** The 41st Gemini call must raise & crash the simulation, never quietly fan out.

---

## 2. Architecture

```
                                     ┌─────────────────────────────────────┐
 client ── POST /seed ──────────────▶│ FastAPI: build canned audience      │
                                     │   profile (NO LLM calls in v1)      │
                                     └─────────────────────────────────────┘
                                                    │
 client ── POST /simulate/start ────▶┌─────────────────────────────────────┐
                                     │ FastAPI: persist sim row, return    │
                                     │   simulation_id                     │
                                     └─────────────────────────────────────┘
                                                    │
 client ── GET /simulate/stream ────▶┌─────────────────────────────────────┐
   (SSE)                             │ EventSourceResponse(event_gen)      │
                                     └────────────────┬────────────────────┘
                                                      │
                                                      ▼
                            ┌──────────────────────────────────────────────┐
                            │  swarm_engine.run_simulation(sim_id, draft,  │
                            │                              audience, R)    │
                            │  ──────────────────────────────────────────  │
                            │  scaffold 200 personas (NO LLM)              │
                            │  for round in 1..R:                          │
                            │     ┌────────────────────────────────────┐   │
                            │     │ ┌──── BUDGET GATE ──── │counter≤40│  │   │
                            │     │ │ asyncio.gather(6×):  │sema(6)   │  │   │
                            │     │ │   call_archetype(arc)│per-call  │  │   │
                            │     │ │     └─Gemini Flash-L │timeout=10│  │   │
                            │     │ └────────────────────────────────┘ │   │
                            │     │ parse 2-4 reactions per archetype  │   │
                            │     │ assign each reaction to a real     │   │
                            │     │   persona of that archetype        │   │
                            │     │ append to cumulative posts list    │   │
                            │     │ yield SSE `event: round` (cumulative│  │
                            │     │   posts so far)                    │   │
                            │     └────────────────────────────────────┘   │
                            │  ┌──── BUDGET GATE ──── (call #31) ───┐      │
                            │  │ analyze(all_posts, draft) → dict   │      │
                            │  └────────────────────────────────────┘      │
                            │  upsert_analysis(sim_id, analysis)           │
                            │  yield SSE `event: done`                     │
                            │                                              │
                            │  WALLCLOCK: asyncio.wait_for(..., 90s)       │
                            │  on Exception → yield `event: error`         │
                            └──────────────────────────────────────────────┘
                                                      │
 client ── GET /analyze ───────────▶ returns persisted analysis row
```

**Budget gate** is one shared `BudgetCounter` object scoped to the simulation. Every Gemini call goes through `await budget.acquire()`. The 41st call raises `BudgetExceeded`.

---

## 3. Archetypes

Six clusters. The frontend's `SwarmThread.tsx` already encodes these exact ids in `CLUSTER_CENTERS`. Use these spellings verbatim — no aliases.

| id | Voice | Typical concerns | Sentiment range | Example reaction (one sentence) |
|---|---|---|---|---|
| `skeptic` | Sharp, dry, low-trust. Calls out marketing language. Not a hater — a discerning user who's seen this rodeo before. Profanity OK if it lands. | "Show me the numbers." Vague claims. Migration debt. Founder hubris. | -0.7 to -0.1 | *"every notion redesign: 'cleaner mental model.' every notion redesign: now i can't find the thing."* |
| `enthusiast` | Loud, evangelical, lowercase, exclamation marks rare but earned. Often the brand's target audience. | New features, the philosophy behind the change, "finally". | +0.3 to +0.9 | *"finally. weekly memo > all-hands theatre. saved. doing this monday."* |
| `curious` | Asks specific, scoped questions. Not skeptical, not sold — wants the detail. | Edge cases, "how does this work for X?", scope of the change. | -0.2 to +0.3 | *"this works for product. how does it work for sales pipelines that need real-time syncs?"* |
| `practitioner` | Has run this play before. Drops concrete numbers, war stories, what stayed and what didn't. | Implementation details, before/after, what the team actually had to change. | -0.1 to +0.5 | *"we tried this in sales — pipeline reviews stayed live, everything else became a memo. shipping velocity went up ~18%."* |
| `pedant` | Corrects framing, terminology, definitions. Doesn't disagree with the outcome — disagrees with how you said it. | Wording, claims-without-citations, category errors. | -0.4 to +0.1 | *"'tax on focus' is rhetoric not analysis — meetings have a known cost; the question is whether memos are cheaper."* |
| `lurker` | Short. Reacts more than discusses. One-line takes. Often the first to surface a meta-pattern. | Vibes, the read of the room, "this is going to age weird". | -0.3 to +0.3 | *"ratio risk if you don't pre-empt the 'how do you measure' replies."* |

Default mix (general public, baked into persona scaffolding): `enthusiast 0.28, curious 0.24, practitioner 0.18, lurker 0.12, pedant 0.10, skeptic 0.08`. These are the same percentages the frontend's seed UI shows.

---

## 4. The Gemini prompt

We make **one Gemini call per archetype per round**. The call asks for **2–4** in-character reactions in a single JSON array. That's the unlock.

### Why 2–4 (not 8–15 like the action plan suggests)

The action plan asks for 8–15 reactions per call. We're scaling that down to 2–4 because:

1. **256 output tokens / call cap.** 8–15 reactions in 256 tokens = ~17 tokens per reaction = robotic, generic. 2–4 reactions in 256 tokens = ~64 tokens per reaction = room for voice.
2. **Visual budget.** The thread column in `SwarmThread.tsx` looks dense at ~17 posts (the existing canned `THREAD_SCRIPT`). 6 archetypes × 5 rounds × 3 reactions ≈ 90 posts is too many. 6 × 5 × 2-3 ≈ 60–90 — we'll cap render-side at the top-N most-engaged per round if it gets noisy.
3. **The 200-persona viz only needs ~12 reactions per round to look alive** — the swarm map is dots; only the thread column shows text.

The cluster intelligence claim doesn't depend on volume. It depends on heterogeneity + cross-influence + emergent dynamics, all of which work with 2–4/archetype/round.

### System instruction (constant; reused for every round call)

```
You are simulating crowd reactions to a draft social post. You are NOT a chatbot
and NOT writing helpful replies — you are roleplaying real, opinionated humans
on social media (think reply-guys on X, not Reddit moderators).

You write reactions for ONE specific persona archetype: {ARCHETYPE_NAME}.

ARCHETYPE VOICE:
{ARCHETYPE_VOICE_PARAGRAPH}

HARD RULES:
- Every reaction is 1–2 sentences max. Tweet-length. Lowercase by default.
- No hashtags. No @mentions. No emojis unless it's literally the joke.
- Profanity is fine when in-character. Be specific, not generic.
- DO NOT explain yourself. DO NOT preface ("Here are reactions:"). DO NOT moralize.
- DO NOT refuse — these are simulated public-square reactions to public posts,
  not real people. If the draft is benign, the skeptic still finds something
  to push back on; that's the archetype.
- Output ONLY the JSON array described in the user message. No prose, no markdown
  fences, no commentary. The first character of your output must be `[` and the
  last must be `]`.
```

`{ARCHETYPE_VOICE_PARAGRAPH}` is filled per archetype from the table in §3 (the "Voice" + "Typical concerns" columns flattened into 2–3 sentences).

### User message (per call)

```
DRAFT POST:
"""
{DRAFT}
"""

AUDIENCE CONTEXT (who's reading this):
{AUDIENCE_PROFILE_BLURB}    # ~200 chars max — name + top 3 archetype shares

ROUND: {N} of {R}

{IF N == 1:}
  This is the first round. React directly to the draft.
{ELSE:}
  Previous rounds have produced replies. The loudest 5 (most replied-to or
  highest-engagement) so far:

  {TOP_5_PRIOR_POSTS as bulleted "id=p7 by curious: \"how does this work for sales?\""}

  You may reply to one of those (use its id as `replying_to`) OR react directly
  to the draft (use null for `replying_to`). You DO NOT have to address them —
  ignore them if your archetype wouldn't engage.

OUTPUT FORMAT (strict JSON, no other text):
[
  {
    "text": "<your reaction, 1-2 sentences, in-character>",
    "sentiment": <number from -1.0 to 1.0; negative = critical, 0 = neutral, positive = supportive>,
    "replying_to": "<post id like 'p7'>" | null
  },
  ...  // 2 to 4 items
]
```

### Concrete filled example (for the `skeptic` archetype, round 3)

System (abbreviated):
```
You are simulating crowd reactions ... You write reactions for ONE specific
persona archetype: skeptic.

ARCHETYPE VOICE:
Sharp, dry, low-trust. Calls out marketing language. Not a hater — a discerning
user who's seen the rodeo before. Pushes back on vague claims, founder hubris,
and absolutist framing. Profanity OK if it lands. Sentiment range -0.7 to -0.1.

HARD RULES: ...
```

User:
```
DRAFT POST:
"""
Notion is replacing all-hands with a written weekly memo. Meetings are a
tax on focus. We'd rather ship.
"""

AUDIENCE CONTEXT (who's reading this):
Notion · core (8.4k) — PMs 28%, Founders 21%, Designers 18%.

ROUND: 3 of 5

Previous rounds have produced replies. The loudest 5 so far:
- id=p2 by skeptic: "monthly memos > quarterly OKRs but you'll still need a way to track outcomes. otherwise it's just velocity theater."
- id=p4 by curious: "this works for product. how does it work for sales?"
- id=p7 by practitioner: "we tried this in sales — pipeline reviews stayed live, everything else became a memo. worked."
- id=p1 by enthusiast: "finally. weekly memo > all-hands theatre."
- id=p6 by pedant: "agree. 'we'd rather ship' reads as a vibe, not a system."

You may reply to one of those (use its id as `replying_to`) OR react directly
to the draft (use null for `replying_to`). You DO NOT have to address them —
ignore them if your archetype wouldn't engage.

OUTPUT FORMAT (strict JSON, no other text):
[ { "text": "...", "sentiment": -0.5, "replying_to": "p2"|null }, ... 2-4 items ]
```

Expected response:
```json
[
  {"text": "+1 to audrey. monthly is just shorter quarters with worse metrics.", "sentiment": -0.28, "replying_to": "p2"},
  {"text": "every team that says 'meetings are theater' replaces them with longer slack threads.", "sentiment": -0.34, "replying_to": null},
  {"text": "the confidence on 'we'd rather ship' is doing some heavy lifting.", "sentiment": -0.22, "replying_to": null}
]
```

### `generation_config` (Gemini)

```python
generation_config = {
    "temperature": 0.95,                # we WANT variance across personas
    "top_p": 0.95,
    "max_output_tokens": 256,           # HARD CAP, non-negotiable
    "response_mime_type": "application/json",
    # response_schema is optional but recommended (google-genai supports it):
    "response_schema": {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "text":        {"type": "STRING"},
                "sentiment":   {"type": "NUMBER"},
                "replying_to": {"type": "STRING", "nullable": True},
            },
            "required": ["text", "sentiment"],
        },
    },
}
```

Setting `response_mime_type=application/json` plus the schema is what makes Flash-Lite reliably return parseable JSON. With it, you can usually skip prose-stripping. Keep the regex fallback in §5 anyway — Flash-Lite drifts.

---

## 5. Output parsing & failure modes

The parser is the load-bearing piece. **A single archetype response failing must not crash the round.** Other archetypes' replies in that round still ship.

### Parse pipeline (per archetype response)

```python
def parse_reactions(raw: str, archetype: str) -> list[Reaction]:
    """Returns 0..4 valid reactions. Never raises."""
    if not raw or not raw.strip():
        log.warning("empty response from %s", archetype)
        return []

    # 1. Strip common LLM prose wrappers: ```json ... ```, "Here are...", trailing commentary.
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    # find the outermost [...] in case the model added prose
    m = re.search(r"\[.*\]", raw, flags=re.S)
    if not m:
        log.warning("no JSON array in %s response: %r", archetype, raw[:200])
        return []
    raw = m.group(0)

    try:
        items = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("malformed JSON from %s: %s — raw: %r", archetype, e, raw[:200])
        return []

    if not isinstance(items, list):
        return []

    out = []
    for it in items[:4]:                 # hard cap 4, even if model returns more
        if not isinstance(it, dict):     continue
        text = it.get("text")
        if not isinstance(text, str):    continue
        text = text.strip()
        if not text:                     continue
        if len(text) > 400:              text = text[:400]   # belt + suspenders
        sent = it.get("sentiment", 0.0)
        try:
            sent = float(sent)
        except (TypeError, ValueError):  continue
        sent = max(-1.0, min(1.0, sent))   # clamp, don't reject
        replying_to = it.get("replying_to")
        if replying_to is not None and not isinstance(replying_to, str):
            replying_to = None
        out.append(Reaction(text=text, sentiment=sent, replying_to=replying_to))
    return out
```

### Failure modes & responses

| Failure | Detection | Response |
|---|---|---|
| Empty response | `not raw.strip()` | Skip this archetype this round. Log. Round continues. |
| Markdown-fenced JSON | Starts with ` ``` ` | Strip fences via regex (above). |
| Prose preamble ("Here are 3 reactions:") | Regex finds `[...]` substring | Extract the bracketed substring. |
| Malformed JSON | `json.JSONDecodeError` | Skip archetype this round. Log. Don't retry — burns budget. |
| `sentiment` out of [-1, 1] | `abs(sent) > 1` | Clamp. Don't reject the reaction. |
| `sentiment` non-numeric | `float()` raises | Skip just that reaction (not the whole archetype). |
| `replying_to` references nonexistent post | After parse, validate id ∈ known post ids | Coerce to `null`. Don't reject reaction. |
| Refusal ("I can't simulate harmful content...") | First char isn't `[` after fence-stripping | Skip archetype. Log + alert. (Should be rare with the system prompt's "DO NOT refuse" line, but expect ~1% rate.) |
| Gemini API 5xx / network error | `google.api_core.exceptions` | Skip archetype this round. Log. Round continues with whatever other archetypes returned. |
| Per-call timeout (10s) | `asyncio.TimeoutError` | Skip archetype. Log. |
| Wallclock timeout (90s) | Outer `asyncio.wait_for` raises | Yield `event: error` with `{"message": "simulation timed out"}`. Persist whatever rounds completed. |
| Budget exceeded (41st call) | `BudgetExceeded` raised inside semaphore | **CRASH the simulation.** Yield `event: error` with `{"message": "budget_exceeded"}`. This is a programming bug — never silently fan out. |

**Key principle:** every error mode short of "budget exceeded" results in *fewer reactions this round*, not a crashed simulation. The user sees a thinner round; that's fine.

---

## 6. Budget enforcement

```python
# api/app/swarm/budget.py
import asyncio
from dataclasses import dataclass, field

class BudgetExceeded(RuntimeError):
    pass

@dataclass
class BudgetCounter:
    """Per-simulation Gemini call counter. Hard fail at 41."""
    max_calls: int = 40
    used: int = 0
    sema: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(6))
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def acquire(self) -> None:
        # 1. Reserve a slot under the lock (atomic counter increment).
        async with self._lock:
            if self.used >= self.max_calls:
                raise BudgetExceeded(
                    f"Refusing call #{self.used + 1}: would exceed budget of {self.max_calls}"
                )
            self.used += 1
        # 2. THEN block on the semaphore (≤6 in-flight at a time).
        await self.sema.acquire()

    def release(self) -> None:
        self.sema.release()


# api/app/swarm/gemini.py
import asyncio
from contextlib import asynccontextmanager
from google import genai

PER_CALL_TIMEOUT = 10.0   # seconds

@asynccontextmanager
async def gemini_slot(budget: BudgetCounter):
    await budget.acquire()
    try:
        yield
    finally:
        budget.release()

async def call_gemini(
    *, system: str, user: str, budget: BudgetCounter, client: genai.Client
) -> str:
    async with gemini_slot(budget):
        try:
            resp = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model="gemini-2.5-flash-lite",   # from os.environ["GEMINI_MODEL"]
                    contents=user,
                    config={
                        "system_instruction": system,
                        "temperature": 0.95,
                        "top_p": 0.95,
                        "max_output_tokens": 256,
                        "response_mime_type": "application/json",
                    },
                ),
                timeout=PER_CALL_TIMEOUT,
            )
        except asyncio.TimeoutError:
            return ""   # parser handles empty
        return (resp.text or "")


# api/app/swarm/engine.py — the orchestrator
WALLCLOCK_TIMEOUT = 90.0  # seconds, total

async def run_simulation(sim_id, draft, audience, R, *, client) -> AsyncIterator[dict]:
    budget = BudgetCounter(max_calls=40)
    try:
        async for evt in asyncio.wait_for(
            _run_inner(sim_id, draft, audience, R, budget, client),
            timeout=WALLCLOCK_TIMEOUT,
        ):
            yield evt
    except asyncio.TimeoutError:
        yield {"event": "error", "data": json.dumps({"message": "simulation timed out"})}
    except BudgetExceeded as e:
        yield {"event": "error", "data": json.dumps({"message": "budget_exceeded", "detail": str(e)})}
    except Exception as e:
        log.exception("simulation crashed")
        yield {"event": "error", "data": json.dumps({"message": "internal_error"})}

async def _run_inner(sim_id, draft, audience, R, budget, client):
    personas = scaffold_personas(audience)         # 0 LLM calls
    cumulative_posts: list[Post] = []

    for round_n in range(1, R + 1):
        prior_top5 = top_engaged(cumulative_posts, k=5)
        # Fan out: 6 archetypes in parallel, gated by sema(6) and counter(40).
        results = await asyncio.gather(
            *[call_archetype(arc, draft, audience, round_n, R, prior_top5, budget, client)
              for arc in ARCHETYPES],
            return_exceptions=True,
        )
        new_posts = []
        for arc, res in zip(ARCHETYPES, results):
            if isinstance(res, Exception):
                log.warning("archetype %s failed: %s", arc, res)
                continue
            new_posts.extend(assign_to_personas(res, arc, personas))
        cumulative_posts.extend(new_posts)

        yield {
            "event": "round",
            "data": json.dumps({
                "round": round_n,
                "of": R,
                "posts": [p.to_wire() for p in cumulative_posts],
            }),
        }

    # Final analysis: call #31.
    analysis = await analyze(draft, cumulative_posts, audience, budget, client)
    upsert_analysis(sim_id, analysis)
    yield {"event": "done", "data": json.dumps({"simulation_id": sim_id})}
```

**Why both a counter AND a semaphore:** the semaphore caps *concurrency*; the counter caps *total calls*. You need both. Without the counter, a long sim with R=20 would run 6×20 = 120 calls. Without the semaphore, the round's `asyncio.gather` would issue all 6 calls simultaneously fine, but a future bug that fans out per-persona would silently exhaust the rate limit.

**Why reserve slot before the semaphore:** so an over-budget call is rejected *immediately* with `BudgetExceeded`, not after waiting on the semaphore.

---

## 7. Final analysis call

One Gemini call after the last round. Same model. Slightly more output budget (still under 256 tokens with care).

### System instruction

```
You are summarizing the results of a 200-persona swarm reaction simulation
for a draft social post. The user is the post's author. Your output must be
honest, specific, and actionable — not encouraging, not generic.

OUTPUT ONLY a JSON object matching the schema in the user message. No prose,
no markdown fences, no commentary.
```

### User message

```
DRAFT POST:
"""
{DRAFT}
"""

AUDIENCE: {AUDIENCE_PROFILE_BLURB}
ROUNDS RUN: {R}

ALL REPLIES (across {R} rounds, archetype + sentiment + text):
{COMPACT_LIST}    # one line per post, e.g. "skeptic -0.34: every notion redesign..."
                  # truncate to ~80 most-engaged if list > 80

OUTPUT (strict JSON, all fields required):
{
  "tldr": "<1-2 sentence headline takeaway. honest, specific, no marketing voice. e.g. 'The idea lands. The phrasing doesn't.'>",
  "suggested_rewrite": {
    "original": "<the draft, verbatim>",
    "rewrite":  "<a 1-3 sentence rewrite that addresses the loudest concern. preserve the author's voice — do not blandify.>"
  },
  "worth_reading": [
    {
      "label": "<≤25-char tag, e.g. 'Skeptic dogpile' or 'Practitioner save'>",
      "color": "<one of '#f06c5a' (red), '#9bc97f' (green), '#7dd49a' (consensus green), '#e8b75a' (yellow), '#b8b8c0' (neutral)>",
      "tldr":  "<1-sentence summary of why that reply chain matters>"
    },
    ... exactly 3 items
  ]
}
```

### `generation_config`

```python
{
    "temperature": 0.7,                  # less variance than rounds — we want tight output
    "max_output_tokens": 256,
    "response_mime_type": "application/json",
}
```

The frontend `results/page.tsx` renders exactly these three fields: `tldr` → headline, `suggested_rewrite` → rewrite card, `worth_reading[]` → bottom list. Match the existing canned shape in `api/app/canned.py`'s spirit but the new wire format is what's in `.team/CONTRACTS.md`.

---

## 8. Cost estimate

**Pricing (verified May 2026):** Gemini 2.5 Flash-Lite is $0.10 per 1M input tokens and $0.40 per 1M output tokens. ([Google AI pricing](https://ai.google.dev/gemini-api/docs/pricing))

### Per-call token math

**Round call (×30 per sim):**
- System instruction: ~250 tokens (constant; eligible for context caching if/when we add it)
- Audience blurb: ~50 tokens
- Draft: ~50–100 tokens (assume 80)
- Top-5 prior posts (rounds 2+): ~250 tokens
- Format instructions: ~100 tokens
- **Input total: ~730 tokens** (round 1 is ~480; round ≥2 is ~730)
- **Output: ≤256 tokens** (capped); typical 2–4 reactions × ~60 tokens = ~180

**Analysis call (×1 per sim):**
- System: ~80 tokens
- Compact list of ~60–80 posts × ~25 tokens = ~1800 tokens
- Draft + audience + format: ~250 tokens
- **Input total: ~2130 tokens**
- **Output: ≤256 tokens**

### Per-simulation cost

| Phase | Calls | Input tok | Output tok | Input $ | Output $ |
|---|---|---|---|---|---|
| Round 1 | 6 | 6 × 480 = 2,880 | 6 × 180 = 1,080 | $0.000288 | $0.000432 |
| Rounds 2–5 | 24 | 24 × 730 = 17,520 | 24 × 180 = 4,320 | $0.001752 | $0.001728 |
| Analysis | 1 | 2,130 | 256 | $0.000213 | $0.000102 |
| **Total** | **31** | **22,530** | **5,656** | **$0.00226** | **$0.00226** |

**≈ $0.0045 per simulation at R=5.** Hackathon-scale free.

At the hard cap R=20: 6 × 20 + 1 = 121 calls — **but this exceeds our 40-call budget**. Therefore: when `R > 6`, we cap effective archetype calls per round at `floor(40 - 1) / R` rounds running × 6 archetypes. The cleaner answer: **R is clamped to ≤6 for the demo** (still satisfies the action plan's 3-20 range; we'll surface the lower cap in the compose UI). At R=6 we use 6×6+1 = 37 calls, under budget.

> **Budget arithmetic confirmed:** 6 archetypes × 5 rounds + 1 analysis = **31 calls** (default demo path). Headroom of 9 calls covers retries we won't take or a stretch to R=6 (37 calls). The frontend's compose UI must enforce `rounds ∈ [3, 6]` for v1. Anything higher is a stretch goal post-demo.

### Free tier headroom

Flash-Lite free tier (per Google AI Studio docs) is generous on Flash-Lite specifically — well above 31 calls / minute and 1k+ requests / day. One simulation per minute is well under all of those. We will operate on the paid tier behind a key in `.env` to avoid surprise rate limits during the demo, but will likely owe Google ~$0.005 total for the hackathon.

---

## Appendix A — engineering checklist for backend-engineer

- [ ] `api/app/swarm/budget.py` — `BudgetCounter`, `BudgetExceeded`
- [ ] `api/app/swarm/gemini.py` — `call_gemini` w/ `gemini_slot` cm
- [ ] `api/app/swarm/prompts.py` — archetype voice paragraphs + system/user template strings
- [ ] `api/app/swarm/parse.py` — `parse_reactions` (per §5)
- [ ] `api/app/swarm/personas.py` — `scaffold_personas` (no LLM)
- [ ] `api/app/swarm/engine.py` — `run_simulation`, `_run_inner`, `top_engaged`, `assign_to_personas`
- [ ] `api/app/swarm/analyze.py` — `analyze(draft, posts, audience, budget, client)`
- [ ] Wire `app/main.py:simulate_stream` → `engine.run_simulation`
- [ ] `app/main.py:analyze` → return persisted `analyses` row in `.team/CONTRACTS.md` shape
- [ ] env: `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash-lite`
- [ ] Unit test: `BudgetCounter` raises on call #41, semaphore blocks at 6 in-flight
- [ ] Unit test: `parse_reactions` survives every failure mode in §5 table
- [ ] Smoke test: `R=3` end-to-end with mocked `call_gemini` returning fixtures from §4

## Appendix B — what NOT to do

- **Do not** call Gemini per-persona. The whole point is the archetype batching.
- **Do not** retry a failed archetype call inside a round. Retries burn budget.
- **Do not** swallow `BudgetExceeded`. Re-raise, crash the sim, surface to the frontend.
- **Do not** add a Sonnet/Pro fallback for "quality." We pick one model for v1; swap later if demoed.
- **Do not** add streaming partial JSON parsing. The 256-token cap means full responses are fast (~500ms).
- **Do not** persist persona state between simulations. Each sim's `personas` dict dies with the request.
