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
