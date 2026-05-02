# CONTRACTS.md — Echo FE↔BE wire format

**LOCKED at v1.** Any change to the shapes below requires `team-lead` approval. Backend-engineer and frontend-engineer code against this in parallel; if either side wants a tweak, raise it with team-lead — do not silently alter.

**Base URL:** in dev, frontend hits `/api/*` and Next's `next.config.mjs` proxies to `http://127.0.0.1:8000` (already wired in `web/next.config.mjs`). All paths below are relative to that base.

**Content type:** all request and non-SSE response bodies are `application/json; charset=utf-8`. Errors use `{ "detail": "<message>", "code": "<machine_code>" }` (FastAPI's `HTTPException(detail=)` is fine — the wrapper below documents what to expect).

**SSE content type:** `text/event-stream` with `cache-control: no-cache`, `connection: keep-alive`. `sse-starlette` already does this.

---

## 1. POST /seed

Build (or load) an audience profile.

**Request body:**

```ts
{
  "mode": "csv" | "oauth" | "sample",
  "payload": string | null    // CSV text (mode=csv), oauth token stub (mode=oauth), null/ignored (mode=sample)
}
```

**200 response:**

```ts
{
  "audience_id": string,        // "aud_<10 hex>"
  "name": string,               // human-readable, e.g. "Notion · core" or "X · @you"
  "size": number,               // integer; e.g. 8420
  "archetypes": [
    { "id": string, "name": string, "share": number },   // share is integer % summing to 100
    ...                          // exactly 6 entries; ids ∈ {skeptic,enthusiast,curious,practitioner,pedant,lurker}
  ]
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 400 | `bad_payload` | `mode=csv` and `payload` is missing/empty/unparseable |
| 401 | `oauth_failed` | `mode=oauth` and the (stubbed) token is rejected |
| 500 | `internal_error` | unexpected; do not include stack trace in body |

**Notes for v1:** v1 returns canned archetype shares regardless of `payload`. Backend-engineer will hardcode the same 6 ids the frontend's `SwarmThread.tsx` uses.

---

## 2. POST /simulate/start

Register a new simulation. Does NOT block on LLM calls — returns immediately.

**Request body:**

```ts
{
  "draft": string,           // 1..1000 chars; the social post to test
  "audience_id": string,     // from /seed
  "rounds": number           // integer in [3, 6] for v1 — see SWARM-DESIGN §8 budget math
}
```

**200 response:**

```ts
{
  "simulation_id": string,   // "sim_<10 hex>"
  "rounds": number,          // echoed
  "status": "running"        // always "running" on 200
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 400 | `bad_request` | draft empty, draft >1000 chars, or rounds out of [3,6] |
| 404 | `unknown_audience` | `audience_id` not in DB |
| 500 | `internal_error` | unexpected |

---

## 3. GET /simulate/stream?simulation_id=…

Server-Sent Events stream of the simulation. The frontend opens this with `new EventSource('/api/simulate/stream?simulation_id=…')` (already wired in `web/src/app/simulating/page.tsx`).

The connection emits a sequence of `event: round` events as rounds complete, then a single terminal `event: done` OR `event: error`, then the server closes.

### `event: round`

Sent once after each round completes. **`posts` is cumulative across all rounds so far** — NOT just the delta for this round. This is so the frontend's `SwarmThread.tsx` can keep filtering by `currentRound` (its existing prop) without buffering state itself.

```ts
event: round
data: {
  "round": number,        // 1-indexed
  "of":    number,        // total rounds (echo of request's rounds)
  "posts": [
    {
      "id":      string,                                            // "p<n>" globally unique within sim, monotonic
      "parent":  string,                                            // either "seed" (top-level reply to draft) or another post id
      "round":   number,                                            // round this post was generated in (1..of)
      "agent": {
        "id":        string,                                        // "a<n>" stable for the sim
        "name":      string,                                        // e.g. "audrey lin"
        "handle":    string,                                        // e.g. "@audrey_lin"
        "archetype": "skeptic"|"enthusiast"|"curious"|"practitioner"|"pedant"|"lurker",
        "audience":  "target"|"public"
      },
      "sentiment": number,                                          // -1.0 to 1.0 (already clamped server-side)
      "text":      string                                           // the reaction body, 1-2 sentences
    },
    ...
  ]
}
```

**Ordering:** `posts` is sorted by `(round asc, id asc)`. Frontend can rely on this; no need to sort.

**Size:** capped at ~120 posts total (6 archetypes × 5 rounds × 4 reactions). Frontend should handle up to 200 defensively.

### `event: done`

Sent once when the analysis call has completed and been persisted. After this the connection closes.

```ts
event: done
data: { "simulation_id": string }
```

After receiving `done`, the frontend should navigate to `/results?id={simulation_id}` (already wired) and call `GET /analyze`.

### `event: error`

Sent in lieu of `done` if the simulation fails. Connection closes after.

```ts
event: error
data: {
  "message": string,        // human-readable
  "code":    string         // machine code; see error taxonomy below
}
```

**Error codes (SSE):**

| code | Meaning |
|---|---|
| `budget_exceeded` | The 41st Gemini call was attempted. Programming bug or runaway loop. Frontend should show "Simulation hit safety limit, please retry" and offer a re-run. |
| `gemini_unavailable` | Gemini API returned 5xx repeatedly or auth failed. Frontend shows "Upstream model unavailable, retrying may help." |
| `simulation_timed_out` | 90s wallclock cap exceeded. Frontend shows "Simulation took too long, please retry." |
| `internal_error` | Anything else unexpected. Frontend shows generic error + a retry button. |

**Reconnection:** if `EventSource.readyState === CLOSED` before `done` was seen, the frontend retries `GET /simulate/stream?simulation_id=…` once. Backend MUST replay all `round` events for that sim (read from `round_events` table) before resuming live emission. v1 alternative: if replay is hard, just re-run from scratch — the frontend treats it as a new stream of the same sim.

---

## 4. GET /analyze?simulation_id=…

Final aggregated analysis. Idempotent — safe to call before, during, or after the stream finishes (returns the latest persisted analysis or 404 if none yet).

**200 response:**

```ts
{
  "simulation_id": string,
  "tldr": string,                                            // 1-2 sentence headline takeaway
  "suggested_rewrite": {
    "original": string,                                      // the original draft, verbatim
    "rewrite":  string                                       // the LLM's rewrite, 1-3 sentences
  },
  "worth_reading": [
    {
      "label": string,                                       // ≤25 char tag, e.g. "Skeptic dogpile"
      "color": string,                                       // hex like "#f06c5a" — frontend renders the dot directly
      "tldr":  string                                        // 1-sentence summary of why this chain matters
    },
    ...                                                       // exactly 3 items
  ]
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 404 | `unknown_simulation` | `simulation_id` not in DB |
| 409 | `analysis_pending` | sim exists but analysis not yet computed (frontend should retry or finish watching the stream first) |
| 500 | `internal_error` | unexpected |

**Notes for v1:** the frontend currently expects extra fields (`ratio_risk`, `tone`, `sentiment`, `replies`, `flags`) from the existing canned `/analyze` shape. **Those fields are dropped in v1 of this contract** — the `results/page.tsx` is being rewritten in Phase C to consume the simpler shape above. Backend-engineer should serve the new shape only. Frontend-engineer is responsible for rewriting the analysis page to render `tldr` + `suggested_rewrite` + `worth_reading[]` only.

---

## 5. Error taxonomy summary

| Where | Status / Event | code | When |
|---|---|---|---|
| Any HTTP | 400 | `bad_request` | malformed body, range violation |
| Any HTTP | 404 | `unknown_audience` / `unknown_simulation` | id not in DB |
| `/seed` | 401 | `oauth_failed` | stub oauth rejected |
| `/analyze` | 409 | `analysis_pending` | sim exists but analysis not yet written |
| Any HTTP | 500 | `internal_error` | unexpected |
| SSE | `event: error` | `budget_exceeded` | 41st Gemini call attempted (HARD FAIL) |
| SSE | `event: error` | `gemini_unavailable` | upstream model 5xx / auth fail |
| SSE | `event: error` | `simulation_timed_out` | 90s wallclock exceeded |
| SSE | `event: error` | `internal_error` | unexpected exception inside `run_simulation` |

Human-readable messages can vary; the `code` is what the frontend branches on.

---

## 6. Frontend integration crib (for frontend-engineer)

- **Audience page (`/audience`)**: POST `/seed` on submit. Store `audience_id` in route state / local storage.
- **Compose page (`/compose`)**: POST `/simulate/start` with `{draft, audience_id, rounds}`. Receive `simulation_id`. Navigate to `/simulating?id={simulation_id}`. Add a `<select>` of `[3, 4, 5, 6]` (default 5) — v1's budget caps at 6.
- **Simulating page (`/simulating`)**: open `EventSource`. On each `event: round`, set `currentRound = data.round` and pass `data.posts` into a new `posts` prop on `SwarmThread`. (Today the component reads from a hardcoded `THREAD_SCRIPT`; frontend-engineer's job is to swap that for the prop.) On `event: done`, navigate to `/results?id={simulation_id}`. On `event: error`, show toast + retry CTA based on `code`.
- **Results page (`/results`)**: GET `/analyze`. If 409, show "Still computing..." + poll every 1s up to 10s. Render `tldr` (headline), `suggested_rewrite` card, `worth_reading[]` list. The existing canned ratio-risk / sentiment / replies / flags UI gets removed in this phase.

---

## 7. Backend integration crib (for backend-engineer)

- **DB schema:** existing `audiences`, `simulations`, `round_events`, `analyses` tables stay. Schema changes:
  - `round_events.payload`: store the cumulative `posts` array per round, JSON-encoded. Lets `/simulate/stream` replay on reconnect.
  - `analyses.payload`: store the new shape (`tldr`, `suggested_rewrite`, `worth_reading`). Drop the old shape's columns; canned legacy is replaced.
- **Persona scaffolding:** generate 200 personas at sim start. Names + handles can come from a static name pool + the persona's index. Archetype distribution per §3 of `docs/SWARM-DESIGN.md`. 70% audience=`public`, 30% audience=`target`.
- **Reaction → persona assignment:** for each parsed reaction in archetype `arc`, pick a random persona of that archetype (without replacement within the sim) and stamp the reaction with that persona's `id/name/handle/archetype/audience`. If you run out (>200 reactions for an archetype, which won't happen at 4×R), wrap with replacement.
- **Post id minting:** monotonic `p1, p2, ...` across the sim. Persisted; remains stable across reconnect.
- **Heartbeat:** `sse-starlette` sends keep-alive comments by default. No additional ping events needed.

---

**v1 LOCKED — 2026-05-01.** Changes require `team-lead` sign-off in `.team/inbox/`.

---

# v2 — additive endpoints (2026-05-02)

**v2 is purely additive.** All v1 shapes (§1–§7 above) remain LOCKED and unchanged. v2 adds two read-only endpoints to support the History page and a "view simulation again" button on `/results`. Both endpoints are **zero LLM calls** — they read from SQLite only.

## 8. GET /history

List past simulations, newest first. Used by `/history` page.

**Request:** no body. Optional query params:
- `limit` (int, default 50, max 200)

**200 response:**

```ts
{
  "items": [
    {
      "simulation_id": string,         // "sim_<10 hex>"
      "draft":         string,         // 1-2 sentence preview (truncate to 240 chars on backend)
      "rounds":        number,         // 3..6
      "post_count":    number,         // total posts persisted (≈24 per round)
      "tone":          "positive" | "caution" | "danger" | "neutral",
                                       // derived from analysis if present:
                                       //   positive  → mean(post.sentiment) ≥  0.20
                                       //   caution   → mean ∈ [-0.10, 0.20)
                                       //   danger    → mean < -0.10
                                       //   neutral   → analysis missing / sim incomplete
      "mean_sentiment": number,        // mean of all post sentiments, -1..1, 2-decimal
      "created_at":    string,         // ISO-8601 UTC, e.g. "2026-05-02T01:50:00Z"
      "has_analysis":  boolean         // true if analyses table has a row for this sim
    },
    ...
  ]
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 500 | `internal_error` | DB read failed |

## 9. GET /simulate/replay?simulation_id=…

Return the final persisted state of a completed simulation as one JSON payload — NOT SSE. Used by `/simulating?id=…&replay=1` (the "View thread" button on /results) and by `/history` cards (when clicked).

**Request:** query param `simulation_id` (required).

**200 response:**

```ts
{
  "simulation_id": string,
  "draft":         string,            // the original draft, verbatim (full, not truncated)
  "rounds":        number,            // total rounds (== highest round in posts)
  "posts": [
    // Same shape as v1 §3 round event's posts[] — cumulative, sorted (round asc, id asc).
    // Fields: { id, parent, round, agent:{id,name,handle,archetype,audience}, sentiment, text }
  ],
  "analysis": null | {
    // Same shape as v1 §4 — { tldr, suggested_rewrite:{original,rewrite}, worth_reading:[3] }
    // null if analysis hasn't been persisted yet (sim still running or errored)
  },
  "created_at": string                 // ISO-8601 UTC
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 404 | `unknown_simulation` | id not in DB |
| 500 | `internal_error` | unexpected |

## 10. Frontend integration crib (additions)

- **`/results` page**: add a secondary "View thread again" button (variant=ghost, icon=replies) next to "Re-run". Routes to `/simulating?id=${simulation_id}&replay=1`.
- **`/simulating` page**: when query param `replay=1`, do NOT open EventSource. Instead, `fetch /api/simulate/replay?simulation_id=…` once, then drive the same paced ingest (1.2s gap per round) using the persisted `posts` partitioned by `post.round`. The 2s linger before /results auto-redirect should be SKIPPED in replay mode (let user navigate manually). Topbar shows "Replay · Round X of Y" instead of "Round X of Y". No "Pause" button (nothing to pause). Add a "Back to results" button instead.
- **`/history` page**: on mount, `fetch /api/history?limit=50`. Render real items in place of the static mock. Each card on click → `router.push('/results?id='+sim_id)` (which already supports loading any sim's analysis from DB). Empty state: "No simulations yet. Run your first one." with a CTA to /compose.

## 11. Backend integration crib (additions)

- **`api/app/db.py`**: add `list_simulations(limit:int) -> list[dict]` reading from `simulations` left-joined with `analyses`. Compute mean_sentiment by reading the latest `round_events.payload` and averaging post sentiments. Compute tone via the thresholds in §8.
- **`api/app/db.py`**: add `get_simulation_full(sim_id) -> dict` returning sim metadata + the latest cumulative posts (from the highest-round `round_events` row) + analysis (or None).
- **`api/app/main.py`**: add the two new routes. Both wrapped in try/except → `internal_error`. Both annotated with strict pydantic response models.

---

**v2 LOCKED — 2026-05-02.** All v1 shapes preserved. Implementations land in Phase E.

---

# v3 — analysis quality + full report (2026-05-02)

**v3 is purely additive + a single field range expansion.** All v1 + v2 shapes remain LOCKED. Three changes:

1. **Draft length cap raised: 280 → 3500 characters.** PR posts, product launches, LinkedIn long-form, Twitter/X premium posts all fit comfortably under 3500. Backend `Field(max_length=3500)` on `/simulate/start.draft`. Frontend Composer counter shows `{len} / 3500`. Visual styling unchanged.

2. **Analysis call upgraded to Gemini 3 Flash Thinking.** Per-archetype reaction calls **stay on `gemini-2.5-flash-lite`** (they're cheap and fine; user explicitly approved keeping these). Only the final aggregate analysis call swaps to the thinking model so it can fit the full thread (≤1M context) and produce accurate findings. The exact model ID MUST be verified via Context7's `query-docs` for `google-genai` or WebSearch (current date: May 2026) before implementation — do not hardcode from memory. New env var: `GEMINI_ANALYSIS_MODEL` (defaults to whatever the verification confirms, e.g. `gemini-3-flash-thinking` or the equivalent dated ID).

3. **Full report endpoint + page.** New deliverable inspired by MiroFish's ReportAgent: a multi-section, scrollable, editorial-tone report on how the public will receive the post. One Gemini-3-thinking call, fed the entire thread + draft + audience metadata. Counts as 1 call (still under the per-sim budget of 40, since a sim has ≤31 + this 1 = ≤32). Cached in a new `reports` table — calling twice for the same sim returns the cached report unless `?regenerate=1`.

## 12. POST /report?simulation_id=…

Generate (or fetch cached) a full-page report on the simulation.

**Request:** query param `simulation_id` (required). Optional query param `regenerate` (bool, default false) — when true, force a fresh Gemini call and overwrite the cached row.

**200 response:**

```ts
{
  "simulation_id": string,
  "draft":         string,
  "audience_label": string,            // e.g. "Notion · core"
  "rounds":        number,
  "post_count":    number,
  "generated_at":  string,             // ISO-8601 UTC of last generation
  "model":         string,              // exact model id used (e.g. "gemini-3-flash-thinking-2026-…")
  "report": {
    "executive_summary":  string,                    // 3-5 sentences, the headline take
    "verdict":            "ship" | "revise" | "rethink",
                                                     // top-level recommendation
    "verdict_rationale":  string,                    // 1-2 sentences explaining verdict
    "audience_reception": [
      {
        "archetype": "skeptic"|"enthusiast"|"curious"|"practitioner"|"pedant"|"lurker",
        "tone":      "positive"|"caution"|"danger"|"neutral",
        "summary":   string,                         // 2-3 sentences on how this archetype received it
        "representative_quote": string               // a direct lift from one of their posts (≤200 chars)
      },
      ...                                             // exactly 6 entries, one per archetype
    ],
    "risk_vectors": [
      {
        "label":     string,                          // ≤30 char tag, e.g. "Cadence credibility"
        "severity":  "low"|"medium"|"high",
        "detail":    string                           // 2-3 sentences
      },
      ...                                              // 2-4 items
    ],
    "rewrite_options": [
      {
        "label":   string,                            // ≤30 chars, e.g. "Softer framing"
        "text":    string,                            // ≤500 chars; the actual rewrite
        "rationale": string                           // 1-2 sentences on why this rewrite addresses what
      },
      ...                                              // 2-3 items
    ],
    "comparable_discourse": string                    // 2-3 sentences referencing similar real-world reactions; may be empty string if model declines
  }
}
```

**Errors:**

| Status | code | When |
|---|---|---|
| 404 | `unknown_simulation` | id not in DB |
| 409 | `report_pending` | another /report call is currently in-flight for this sim (concurrency guard) |
| 502 | `gemini_unavailable` | upstream model 5xx / auth fail |
| 500 | `internal_error` | unexpected |

**Cost:** 1 Gemini call per generation. Total per-sim budget remains ≤40 (typical sim ≤32 with report).

**Latency:** thinking model is slower than Flash-Lite — expect 5-20s. Frontend shows a "Generating full report…" loading state.

## 13. Frontend integration crib (additions)

- **`/results` page:** add a third footer button — "**See full report**" (variant=primary, `icon={<Icon name="zap" size={13}/>}` or similar) right of "Use rewrite". On click, route to `/report?id=${simulation_id}`.
- **NEW `/report?id=…` page:** dedicated full-page route. On mount, `POST /api/report?simulation_id=…`. Show a generation spinner if first time (~5-20s). When response lands, render the structured report sections in a long scrollable column with the existing app shell (sidebar + topbar). Topbar reads "Full report". The report is the page — no extra chrome. Add a "Regenerate" ghost button that POSTs with `?regenerate=1` and a "Back to results" ghost button.
- **Compose char limit:** raise the visible counter ceiling from 280 to 3500. Counter turns red past 3500, not 280.

## 14. Backend integration crib (additions)

- **`api/app/db.py`**: add `reports` table on init: `(simulation_id PK, payload TEXT, model TEXT, generated_at TEXT)`. Add helpers `get_report(sim_id) -> dict | None`, `upsert_report(sim_id, payload, model)`.
- **`api/app/swarm.py`**: split the gemini call layer into two model targets. Keep `_call_gemini` for Flash-Lite (per-archetype reactions). Add `_call_gemini_thinking` for the thinking model. Both share the BudgetCounter and the process-global semaphore. The analysis function (currently last call inside `run_simulation`) switches to `_call_gemini_thinking`. Add a new `generate_report(sim_id) -> dict` function that loads the persisted thread + draft + audience, builds a long prompt with the full thread, calls thinking-model once with `response_schema` matching §12's `report` shape, persists, returns.
- **`api/app/main.py`**: add `POST /report` route per §12. Concurrency guard via an in-process dict `{sim_id: asyncio.Lock}` so concurrent calls for the same sim queue, not duplicate. Return cached report if `regenerate=False` AND a row exists.
- **Increase draft cap:** `SimulateStartRequest.draft = Field(min_length=1, max_length=3500)`.

## 15. Model verification (R1, MANDATORY)

The Gemini 3 Flash Thinking model ID must be confirmed via:
- **Context7 `mcp__claude_ai_Context7__query-docs`** for `google-genai` (Python SDK), looking for thinking-mode model strings.
- **OR WebSearch** with current year (May 2026) for "gemini 3 flash thinking model id google ai".

The implementing agent MUST cite the source they verified against in their commit message (e.g. "verified `gemini-3-flash-thinking-001` via Context7 google-genai docs 2026-05-02"). Do NOT pick a model ID from training-data memory — Gemini's lineup has shifted multiple times and we need the live truth.

If the thinking model is unavailable / costs prohibitively / latency is unacceptable (>30s p95), document it in `.team/inbox/gemini-3-thinking-unavailable.md` and message team-lead — do NOT silently fall back to a different model.

---

**v3 LOCKED — 2026-05-02.** All v1 + v2 shapes preserved. Implementations land in Phase F.

---

## v4 (LOCKED — 2026-05-02): pivot to "what will people think if..."

**v4 is purely additive over v1 + v2 + v3.** All prior shapes remain LOCKED. v4 introduces a `mode` discriminator on `/simulate/start` so the product can serve two flows: the existing `business` flow (audience-bound) and a new `hypothetical` flow ("what if X?") that doesn't require a user-built audience.

### § 16. POST /simulate/start (additive update over v1 §2)

**Request:**

```ts
{
  "draft":       string,                              // 1..3500 (unchanged from v3 §13)
  "mode":        "business" | "hypothetical",         // NEW; default "business" if absent
  "audience_id": string | null,                       // NOW OPTIONAL; required when mode="business"
  "rounds":      number                               // [3,6] (unchanged)
}
```

**Response:** unchanged from v1 §2 — `{ simulation_id, rounds, status }`.

### § 17. `mode` field on response shapes

The following response models gain an additive `mode: "business" | "hypothetical"` field. Defaults to `"business"` for legacy rows (DB-level default) so existing cached payloads still validate.

- **HistoryItem** (v2 §8) gains `mode`.
- **ReplayResponse** (v2 §9) gains `mode`.
- **ReportResponse** (v3 §12) gains `mode`.

### § 18. New error code

| Status | code | When |
|---|---|---|
| 400 | `audience_id_required_for_business_mode` | `mode="business"` and `audience_id` is null/missing on `/simulate/start` |

All other errors from v1 §5 still apply. `unknown_audience` (404) only fires when `mode="business"` and the supplied `audience_id` is well-formed but not in the DB.

### § 19. Backward compatibility

- Legacy callers that omit `mode` get the default `"business"` — existing FE keeps working unchanged.
- Existing `simulations` rows written before v4 default to `mode="business"` via SQLite DEFAULT on the new column (idempotent `ALTER TABLE … ADD COLUMN mode TEXT NOT NULL DEFAULT 'business'`).
- Hypothetical-mode sims are routed against a built-in `GENERAL_PUBLIC_AUDIENCE` (id `aud_public____`, name `"General public"`, size 10000, archetypes = `default_audience_archetypes()`). The sentinel id is stored in `simulations.audience_id` to satisfy the schema's NOT NULL constraint; the read path routes on `mode`, not on the id shape, so this is invisible at the wire boundary.
- Engine, prompt, budget, SSE shape — all unchanged in v4. Hypothetical-specific copy lands in P4/P6.

---

**v4 LOCKED — 2026-05-02.** All v1 + v2 + v3 shapes preserved. Implementations land in Phase 2.

---

## v5 (LOCKED — 2026-05-02): rounds range expanded

### § 20. POST /simulate/start — additive update over v4 §16

Request `rounds` field range changes from `[3, 6]` to `[5, 15]`.
- Existing FE sending rounds in [3, 4] now receives 422 validation error.
- Migration check: confirm no production rows depend on rounds < 5 before deploy.
  Hackathon-stage: pre-Q1 sims with rounds<5 remain in DB; only NEW sims are constrained.
- Default unchanged (FE picks its own default; backend just enforces range).


---

## v6 (LOCKED — 2026-05-02): real engagement signal on posts

### § 21. SSE `event: round` — Post shape additive update

Each post in `posts[]` gains two new fields:

```ts
{
  // ... v1 §3 fields unchanged ...
  "like_count": number,    // NEW — int ≥ 0; deterministic per (sim_id, post_id), monotonically non-decreasing across rounds
  "reply_count": number    // NEW — int ≥ 0; computed as |{p in posts | p.parent == this.id}| at SSE emit time
}
```

Both fields default to `0` if absent (backward-compat for v1-v5 callers / replays of pre-v6 sims).

### § 22. Engagement semantics (server-side, FE consumes)

- **`like_count` is computed deterministically**, not via LLM. Algorithm lives in `swarm.py`. Inputs: post archetype, post sentiment, post round, current round (for visibility decay), audience archetype mix. Same `(sim_id, post_id, round)` tuple → same `like_count`. **This guarantees replay parity** (L22).
- **`like_count` is monotonically non-decreasing.** A post emitted in round N may have `like_count = 5` in round N's SSE event, then `like_count = 8` in round N+1's SSE event (because more rounds = more "scrolling personas" who saw and liked it). FE must accept the latest value per post-id.
- **`reply_count` is recomputed on every SSE emit** as a function of cumulative posts. FE accepts the latest value.
- Wire size impact: 2 small ints per post × ~90 posts at rounds=15 = ~1.5KB total. Negligible.

### § 23. Smarter reply-targeting in `_build_user_prompt`

The `prior_top` block (formerly "loudest 5 by id") now ranks prior posts by `engagement_score = like_count + reply_count * 2`, descending. The top 4 by score plus 1-2 random low-engagement posts are surfaced to each per-round-per-archetype prompt. This is the "scroll then engage" model: model sees trending + discovery, picks what to react to.

This is a **prompt change**, not a wire change. FE/BE wire shapes unchanged.

### § 24. Backward compatibility

- v1-v5 wire shapes preserved.
- Replays of pre-v6 simulations: backend re-derives `like_count`/`reply_count` from the deterministic algorithm at replay time (or returns 0 if the algorithm wasn't yet enabled — FE must tolerate 0).
- Existing FE consuming v1 §3 posts will silently ignore the new fields. New FE relies on them for engagement-DESC sort + heart-pop animations.

---

**v6 LOCKED — 2026-05-02.** Implementations: backend in `swarm.py` engagement algorithm; frontend in `SwarmThread.tsx` indented tree + engagement re-sort.


---

## v7 (LOCKED — 2026-05-02): agentic per-persona swarm ("Crowd v7")

The engine moves from "6 archetype LLM batches per round" to "per-persona-per-round LLM agents." Personas gain rich profiles (bio, profession, hot-buttons) and make their own decisions each round (post / reply / like / skip). Engagement becomes LLM-emergent. v6 path remains for backward-compat (gated behind `ECHO_ENGINE_VERSION` env).

### § 25. Post.agent — additive profile fields

```ts
{
  // ... existing v1 §3 + v4/v6 fields unchanged ...
  "agent": {
    "id": string,
    "name": string,
    "handle": string,
    "archetype": "skeptic" | "enthusiast" | "curious" | "practitioner" | "pedant" | "lurker",
    "audience": "target" | "public",
    "bio": string,                       // NEW v7 — short voice descriptor (60-120 chars). Empty string for v1-v6 replays.
    "profession": string | null,         // NEW v7 — single concise descriptor; null for v1-v6 replays.
    "hot_buttons": string[] | null       // NEW v7 — 1-3 issues this persona cares about; null for v1-v6 replays.
  }
}
```

All three new fields are **optional on read** for backward compat. Old FE silently ignores them; new FE surfaces them via tooltip / panel.

### § 26. Engagement provenance

- **v6 sims (existing data)**: `like_count` + `reply_count` are re-derived at SSE emit / replay time via the deterministic R1 algorithm in `attach_engagement` (CONTRACTS §22). Unchanged.
- **v7 sims (new data)**: `like_count` is the **sum of LLM-decided per-persona likes** for each post, optionally multiplied by `_LIKE_DISPLAY_MULTIPLIER` (server-side display knob, default 1). `reply_count` unchanged (children count).
- The wire shape is identical regardless of provenance. FE need not branch on engine version.

### § 27. POST /simulate/start — additive request field

```ts
// Request superset of v6
{
  "draft": string,
  "mode": "business" | "hypothetical",
  "audience_id": string | null,
  "rounds": number,                    // [5, 15] (v5 §20)
  "persona_count": number | null       // NEW v7 — int [30, 100], default 50 (v7 only); null/absent → 50 (v7) or ignored (v6)
}
```

`persona_count` only takes effect when `ECHO_ENGINE_VERSION=v7`. Server-side default = 50 when v7 + null. Out-of-range values return 422.

### § 28. Replay payload format

For v7 sims, `round_events.payload` JSON gains a sibling field alongside the existing `posts`/`round`/`of`:

```ts
{
  "round": number,
  "of": number,
  "posts": [...],                      // unchanged shape
  "persona_actions": [                  // NEW v7 — per-persona decision log for this round
    {
      "persona_id": string,
      "action": "post" | "reply" | "skip",
      "text": string | null,
      "replying_to": string | null,
      "sentiment": number | null,
      "likes_given": string[]          // post ids; max 5
    },
    ...
  ]
}
```

This guarantees **replay parity**: the v7 round-event JSON contains the full LLM decision trace; replay re-renders directly from disk with no LLM re-run (L22 — determinism = persistence for v7). v6 round events lack `persona_actions` and replay falls through to the R1 deterministic re-derivation.

### § 29. Engine versioning (operational)

- `ECHO_ENGINE_VERSION` env var, values `"v6"` | `"v7"`. Default `"v6"` until Z2 verification passes.
- v6 sims and v7 sims **coexist in the same DB**. Routing on engine version is internal to the engine; the wire shape is the same.
- Replay handler routes on whether `round_events.payload` contains `persona_actions` (v7) or not (v6). No new DB columns needed beyond Z1's `personas` table.

### § 30. Backward compatibility

- All v1-v6 wire shapes preserved.
- `agent.bio` / `agent.profession` / `agent.hot_buttons` default to empty/null for v1-v6 replays. New FE tolerates absence.
- `persona_count` is optional; v6 callers ignore it.
- `_LIKE_DISPLAY_MULTIPLIER` is internal (never on the wire).
- Existing `personas` table introduced in Z1 is opt-in (only populated for v7 sims).

---

**v7 LOCKED — 2026-05-02.** Implementations land in Phases Z1 (persona genesis + persistence), Z2 (engine rewrite), Z3 (FE surfacing). Engine flag enables instant rollback.


---

## v8 (LOCKED — 2026-05-02): web-grounding loading-state events

User reported the silent ~22s delay between sim start and round 1 (when `web_grounding=true`) felt like a hang. This adds dedicated SSE event types so the FE can surface a "searching the web…" banner while the grounding pre-call runs.

### § 31. SSE `event: grounding` (NEW, additive)

Emitted ONLY when `web_grounding=true` on `/simulate/start`. Fires from `run_simulation` BEFORE any `event: round`. Multiple events allowed per sim (typically `searching` then either `done`, `skipped`, or `failed`).

```ts
// data shapes by status
{ "status": "searching" }
{ "status": "done", "chars_added": number }
{ "status": "skipped", "reason": string }   // empty context returned (LLM returned "NONE" or no relevant facts)
{ "status": "failed", "reason": string }    // grounding pre-call raised; swallowed; sim still proceeds ungrounded
```

### § 32. Sequence guarantees

- If `web_grounding=true` → exactly ONE `searching` event is emitted, followed by exactly ONE of `{done, skipped, failed}`. Then `event: round` events stream as normal.
- If `web_grounding=false` (or absent / null) → NO `grounding` events. Existing v6/v7 stream shape unchanged.
- `BudgetExceededError` from the grounding pre-call still propagates as `event: error` with code `budget_exceeded` (the BudgetCounter raised — same handling as today).

### § 33. Replay parity

Grounding events are NOT persisted in `round_events.payload` (those rows store per-round cumulative posts). On replay, the banner is naturally absent. v8 introduces no DB schema changes.

### § 34. Backward compat

- Old FE that doesn't listen for `event: grounding` silently ignores it — sse-starlette / EventSource skips events the client hasn't bound a handler for.
- New FE listens for the event but tolerates its absence (web_grounding off, or older sims).
- Wire shape v1-v7 preserved.

---

**v8 LOCKED — 2026-05-02.** Implementation: backend yields the new event from `run_simulation`'s grounding pre-call branch; frontend renders a transient banner in `/simulating`. Lead writes the contract before parallel BE+FE spawn.

---

## v10 (LOCKED — 2026-05-02): per-persona voice cadence (de-template)

User reported template-collapse in v7 hypothetical sims — large fraction of posts opened with "okay i'm hearing 'hypothetical question'…" / "yo, hypothetical question…" variants. Diagnosis: salient anchor word ("hypothetical scenario") in the persona system prompt + no per-persona structural variation in opener style. v10 adds a deterministic per-persona `voice_cadence` enum that steers each persona toward a different opener shape. Pure prompt-side fix; no FE change; sampling unchanged.

### § 37. `RichPersona.voice_cadence: string` (NEW, additive on persona record)

Closed enum, deterministically sampled at persona-genesis time from a stable hash of `persona_id` so replay reads back the same value:

```
"direct"        — open with the take, declarative
"interrogative" — open with a question
"clipped"       — fragment / one-liner / sentence-trail
"narrative"     — open with personal anecdote or context
"wry"           — open with sarcastic understatement / dry irony
"analytical"    — open with the frame / mechanism / second-order effect
"emotional"     — open with the felt reaction (a feeling word, not an emoji)
```

- Distribution: deterministic, uniform-ish across the persona pool (`hash(persona_id) % 7`). At 50 personas → ~7 per cadence ± stddev. At dev-mode 17 → ~2-3 per cadence.
- **Genesis LLM does NOT pick cadence** — it's a post-genesis deterministic assignment so cadence stays uncorrelated with archetype/profession/bio.
- Persisted in `personas` table (new `voice_cadence TEXT NOT NULL DEFAULT 'direct'` column, idempotent ALTER TABLE — same pattern as the `web_grounding` column).
- v6 sims have no `voice_cadence` (pre-Z table didn't exist) → graceful default 'direct'.

### § 38. `agent.voice_cadence?: string | null` on Post wire shape (NEW, additive, optional, FE-invisible)

The wire field is plumbed for completeness/debugging only. The FE does NOT render it — cadence is an internal LLM hint, not user-visible metadata. Old FE that ignores the field works unchanged.

### § 39. Replay parity

Cadence is read from the persisted `personas` table, not re-sampled at replay time. Identical sim_id → identical cadence per persona. v6 sims (no row in `personas`) replay unaffected.

### § 40. Backward compat

- Wire shape v1-v9 preserved. New field is strictly additive.
- v6 / pre-D-batch v7 sims: `voice_cadence` defaults to 'direct' on read, FE doesn't display it, no behavioral regression.
- New persona system prompt removes the salient anchor word "hypothetical scenario" — describes the input by what the persona does (react to substance) not what the input is. Mode-agnostic.

---

**v10 LOCKED — 2026-05-02.** Implementation: D0 (lead — prompt rewrites + sanitizer + few-shot expansion), D1 (BE — persona_genesis + DB), D2 (lead — verification + P6 regression check), D3 (lead — LEARNINGS).

---

## v11 (LOCKED on `experimental/gif-reactions` branch — 2026-05-02): persona reaction GIFs

User asked to add reaction GIFs to the swarm on a separate "fun" branch — main stays untouched until a perf gate passes. v11 adds a closed-enum `gif_reaction` field that personas optionally pick on each post. The wire shape is asset-agnostic: the FE may render a static `<img>` from `/gifs/<tag>.gif` OR an emoji + CSS keyframe animation looked up from a tag→animation map. v0 ships emoji + CSS for zero asset weight, zero bundle delta, and crisp rendering at any scale; static GIF files are a reserved upgrade path the user can populate later.

### § 41. `gif_reaction: string | null` field on persona action JSON (NEW, additive, optional)

Closed enum, 25 tags:

```
eye_roll, popcorn, mind_blown, this_is_fine, side_eye, slow_clap, head_shake, shrug,
thumbs_up, thumbs_down, applause, suspicious, shocked, deep_sigh, mic_drop, facepalm,
laughing, crying, nervous, bored, cheers, point_up, no_thanks, thinking, wave
```

- LLM-decided per persona action via the `_PERSONA_ACTION_SCHEMA` enum constraint (Gemini honors enum values; out-of-enum drops to null at parse time).
- Frequency budget: prompt nudge ("default to null, ~1-in-10 posts") + parse-time rarity cap (≤15% of posts per round; randomly null out the surplus).
- Persisted in `round_events.payload.persona_actions[*].gif_reaction` (existing v7 persistence path).
- Surfaced on the wire as `agent.gif_reaction?: string | null` on the post agent block (mirrors how D1's `voice_cadence` surfaces).

### § 42. FE rendering convention (asset-agnostic)

The FE owns the visual interpretation of the tag. v0 ships an **emoji + CSS keyframe animation map** keyed by tag — each of the 25 tags maps to a unicode emoji + a named animation (bounce, wobble, spin, pulse, shake, sway). Rendered as a small inline span between body text and action row in `TweetCard.tsx`, ~32-36px font-size, animation looped.

**Reserved upgrade path**: if `web/public/gifs/<tag>.gif` exists, the FE may switch to `<img src="/gifs/<tag>.gif" loading="lazy">` instead. Static-GIF rendering is OUT OF SCOPE for v0 but the wire shape supports it without any code change.

### § 43. Engine flag `ECHO_GIFS_ENABLED`

- Default `1` on `experimental/gif-reactions` branch.
- Default `0` if the branch ever merges to `main` (kill-switch even after merge — flip to `1` to enable).
- When `0`: the schema field is absent from the spec, the prompt rule is absent, the aggregator passes through `None` everywhere. FE still tolerates a null/absent field gracefully.

### § 44. Replay parity

`gif_reaction` persists in `round_events.payload` and reads back verbatim on `/simulate/replay`. Pre-G sims have null/absent on read → FE skips render. v6 sims unaffected.

### § 45. Backward compat

- Wire shape v1-v10 preserved. v11 is strictly additive.
- Old FE that doesn't render the field works unchanged (the field is just ignored).
- New FE tolerates the field's absence (pre-G sims, ECHO_GIFS_ENABLED=0, v6 replays).

---

**v11 LOCKED — 2026-05-02 on `experimental/gif-reactions`.** Implementation: G0 (lead — branch + contracts), G1 (BE agent — schema + parser + aggregator + flag), G2 (FE agent — emoji+CSS render slot), G3 (lead — perf gate + merge decision). **`main` stays untouched until perf gate passes AND user OKs the merge.**
