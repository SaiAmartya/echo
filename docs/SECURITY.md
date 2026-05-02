# SECURITY.md — Phase E3 audit (2026-05-01)

Auditor: `security-auditor`. Scope: API + frontend audit surface as of commit
`ea39bbf` (Phase E1 landed; Phase E2 in progress in another working tree).
Methodology: static analysis + curl probes against the running dev server.
Zero Gemini calls (R2). Pydantic 2.13 / FastAPI 0.136 syntax verified against
the locally installed venv before applying fixes.

Fixes landed in this audit:
- `968c460` — `fix(phase-e3): boundary-validate ids + cap /seed payload size`

---

## A. Secret hygiene — PASS

- `git check-ignore api/.env` → `api/.env` (gitignored). ✅
- `git grep -nE 'AIza[0-9A-Za-z_-]+' -- ':!*.lock' ':!.git'` → ZERO hits. ✅
- Tracked env files: `api/.env.example` and `web/.env.local.example`. Both
  contain placeholder keys only (verified by reading), no live secrets. ✅
- CORS `allow_origins` in `api/app/main.py` is the locked-down list
  `["http://localhost:3000", "http://127.0.0.1:3000"]`. NOT `["*"]`. ✅
- `allow_credentials=True` is safe given the explicit origin list (FastAPI
  refuses the `*` + credentials combo at startup anyway).

## B. SQL injection — PASS

Every `conn.execute` in `api/app/db.py` uses positional `?` placeholders:
- `insert_audience`, `insert_simulation`, `insert_round_event`,
  `upsert_analysis`, `get_simulation`, `get_audience`, `get_round_events`,
  `get_analysis`, `_latest_round_payload`, `list_simulations`,
  `get_simulation_full` (every cursor.execute call audited). ✅
- The single `executescript(SCHEMA)` in `init_db` runs a static module-level
  string. ✅
- No f-string interpolation of user-controlled values into SQL anywhere in
  `api/app/db.py`. ✅

Probe `?simulation_id=' OR 1=1--` returns 404 (URL-encoded) — DB lookup misses
safely; no error leakage.

## C. Input validation at boundaries — PARTIAL → PASS (after fix)

State **before** this phase (probe results against running server):

| Check | Status | Notes |
|---|---|---|
| `/seed` mode whitelist | PASS | `Literal["csv","oauth","sample"]` rejects 422 on `"hack"`. |
| `/seed` payload bounded | **FAIL** | No `max_length`. 5 MB body did 422 via FastAPI/uvicorn body limit; smaller-than-limit junk would have been accepted. |
| `/simulate/start` draft 1..1000 | PASS | `Field(min_length=1, max_length=1000)` — 422 on empty + on 1500 chars. |
| `/simulate/start` rounds [3,6] | PASS | `Field(default=5, ge=3, le=6)` — 422 on `99`. |
| `/simulate/start` audience_id format | **FAIL** | No regex; `"<script>alert(1)</script>"` accepted by parser, then DB lookup missed → 404. |
| `/simulate/stream` simulation_id format | **FAIL** | No regex on `Query(...)`. Bad ids fell through to DB lookup. |
| `/analyze` simulation_id format | **FAIL** | Same. |
| `/simulate/replay` simulation_id format | **FAIL** | Same. |
| `/history?limit` clamp [1, 200] | PASS | `Query(default=50, ge=1, le=200)` — 422 on `-1` and `999999`. |

State **after** commit `968c460` (this audit's fix):

- `SeedRequest.payload` now `Field(default=None, max_length=1_000_000)`.
- `SimulateStartRequest.audience_id` now `Field(pattern=r"^aud_[0-9a-f]{10}$")`.
- `_SIMULATION_ID_PATTERN = r"^sim_[0-9a-f]{10}$"` applied via
  `Query(..., pattern=...)` to `/simulate/stream`, `/analyze`,
  `/simulate/replay`.

Verified locally: pydantic accepts `aud_abc1234567`, rejects `<script>`,
`aud_xxx`, `AUD_abc1234567`, `aud_abcdef1234567` (too-long), and empty.

> Note: bad-format ids now return HTTP 422 (FastAPI's default validation error
> shape, `{"detail": [...]}`) instead of 404 with `{"detail":..., "code":...}`.
> The frontend's `parseError` (web/src/lib/api.ts) already maps non-recognized
> codes to `internal_error`, so the UI still shows a generic error. This is an
> acceptable tradeoff because legitimate users only ever send ids the API
> itself minted.

## D. Error swallowing / unhandled exceptions — PASS

- `swarm._call_gemini` (api/app/swarm.py:259-286): `asyncio.TimeoutError` and
  generic `Exception` are logged and return `""`. Parser short-circuits on
  empty input → round continues with 0 reactions for that archetype. ✅
- `swarm.parse_reactions`: best-effort; never raises; clamps sentiment;
  truncates long text; ignores non-dict items. ✅
- `swarm.run_simulation`: `_producer` task wraps `_inner` in try/except;
  `BudgetExceededError` and generic `Exception` both push a structured
  `event: error` onto the SSE queue with the contract codes. ✅
- `main.simulate_stream.event_gen`: extra try/except wraps the iteration to
  emit `event: error code=internal_error` if anything inside `run_simulation`
  somehow propagated past the producer. Log includes traceback. ✅
- `main.history` and `main.simulate_replay`: try/except → 500
  `internal_error` with `log.exception`. ✅
- Frontend `web/src/app/simulating/page.tsx`: `ErrorState`, `errorCopy`
  (mapping all four contract SSE codes), retry handler, `onConnectionError`
  for transport drops, `onErrorEvent` for server-emitted `event: error`. ✅
- Frontend `web/src/app/results/page.tsx`: try/catch around `analyze` fetch
  with explicit handling of `analysis_pending` (409) plus generic fallback. ✅

## E. Budget guard integrity — PASS (1 NOTE for team-lead review)

- `BudgetCounter.acquire` (swarm.py:219-226) increments `self.used` under a
  lock BEFORE awaiting the semaphore and BEFORE the actual Gemini call.
  Threshold check raises `BudgetExceededError` immediately at attempt #41. ✅
- `BudgetCounter` is instantiated **per simulation** inside `run_simulation`
  (swarm.py:548). Two concurrent sims do NOT share the counter. ✅
- **NOTE / FLAG (NOT fixed — load-bearing, needs team-lead approval):** the
  `asyncio.Semaphore(MAX_CONCURRENT)` is also created **per simulation** as a
  field on `BudgetCounter` (swarm.py:214-216). Per the task's audit checklist
  the concurrency semaphore SHOULD be process-global so two concurrent sims
  don't double the upstream call rate. Today, two parallel sims could each
  run 6 in-flight calls = 12 total. At hackathon scale this is fine (we're
  not multi-tenant) but it does diverge from `RULES.md` R2 ("≤6 concurrent
  calls via asyncio.Semaphore(6) (process-global)"). Not patched here because
  budget logic is load-bearing and changing semaphore lifetime affects test
  fixtures. Recommend a follow-up: lift the semaphore to module scope,
  retain the per-sim counter as-is. Filed as backlog item.

## F. XSS surface — PASS

- `git grep -nE 'dangerouslySetInnerHTML|innerHTML|eval\b' web/src` →
  ZERO hits. ✅
- LLM-generated text (`{post.text}`, `{analysis.tldr}`, etc.) is rendered as
  JSX text children → React auto-escapes. ✅
- API client uses `encodeURIComponent` on all query-param interpolations
  (`web/src/lib/api.ts:simulateStreamUrl`, `analyze`, `getReplay`). ✅

## G. Production deployment risk — NOTE

Echo as built is a hackathon demo. Before any public deployment, the
following must be addressed. Today these are **deliberately accepted risks**
because the demo is local-only:

1. **No auth.** The sign-in page is decoration (`web/src/app/signin/page.tsx`).
   Anyone with the URL can run simulations. CORS pins to localhost only,
   which is the only thing keeping the API from being callable cross-origin.
2. **No per-account or per-IP rate limiting.** Budget caps are per-simulation
   (≤40 Gemini calls) but a script can simply fire many simulations in a
   loop. Fine on localhost; weaponizable on the open internet.
3. **Gemini API key is server-side only** (`api/.env`, gitignored). Never
   exposed to the browser. ✅
4. **No PII collected.** Audience seeding accepts CSV but the only canned
   audiences are deterministic. Drafts are stored in SQLite indefinitely —
   add retention policy if real users hit the system.
5. **Demo SQLite DB is single-file, no auth, no encryption.** OK for a local
   hackathon judge, not for prod.

**Hard rule for this codebase: do NOT deploy publicly without (a) real auth,
(b) per-account budget caps, and (c) per-IP rate limiting.** All three are
out of scope for the hackathon.

---

## Summary

| Section | Verdict | Action |
|---|---|---|
| A. Secret hygiene | PASS | none |
| B. SQL injection | PASS | none |
| C. Input validation | PARTIAL → PASS | fixed in `968c460` |
| D. Error swallowing | PASS | none |
| E. Budget guard | PASS + NOTE | flagged semaphore scope for team-lead |
| F. XSS surface | PASS | none |
| G. Deployment risk | NOTE | documented; demo stays local-only |

**Issues found:** 5 (4 input-validation gaps in §C, 1 semaphore-scope note in §E).
**Fixes applied:** 4 (all of §C in commit `968c460`).
**Deliberately not fixed:** 1 (semaphore scope — needs team-lead approval per
RULES.md R3 + the task's E. instruction "do NOT fix without team-lead
approval — budget logic is load-bearing").

Verification commands rerun-able anytime:

```bash
# A
git check-ignore api/.env
git grep -nE 'AIza[0-9A-Za-z_-]+' -- ':!*.lock' ':!.git'

# C — should all be 4xx
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8000/analyze?simulation_id=foo"
curl -s -o /dev/null -w "%{http_code}\n" --get --data-urlencode "simulation_id=' OR 1=1--" "http://127.0.0.1:8000/simulate/replay"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8000/history?limit=-1"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8000/history?limit=999999"

# F
git grep -nE 'dangerouslySetInnerHTML|innerHTML|eval\b' web/src
```
