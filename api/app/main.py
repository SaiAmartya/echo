"""Echo FastAPI backend — Phase B (Gemini-backed swarm engine).

Endpoints:
  POST /seed              — build (canned) audience profile of the 6 archetypes
  POST /simulate/start    — register a new simulation, return id
  GET  /simulate/stream   — SSE stream of cumulative round events + done/error
  GET  /analyze           — final aggregated analysis (tldr / rewrite / worth_reading)

Wire format is locked in .team/CONTRACTS.md. The swarm engine itself lives in
api/app/swarm.py — this module is the thin HTTP layer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

# Load api/.env before anything reads os.environ (firebase-admin creds,
# GEMINI_API_KEY, etc.). Idempotent — safe if already loaded by swarm.py.
from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, HTTPException, Query  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
from sse_starlette.sse import EventSourceResponse  # noqa: E402

from .auth import current_user_uid, current_user_uid_from_query  # noqa: E402
from .db import (  # noqa: E402
    get_analysis,
    get_audience,
    get_audience_unscoped,
    get_personas,
    get_report,
    get_simulation,
    get_simulation_full,
    get_simulation_unscoped,
    init_db,
    insert_audience,
    insert_round_event,
    insert_simulation,
    list_simulations,
    upsert_analysis,
    upsert_report,
)
from .swarm import (  # noqa: E402
    GENERAL_PUBLIC_AUDIENCE,
    GeminiUnavailableError,
    ReportSimNotFoundError,
    attach_engagement,
    default_audience_archetypes,
    generate_report,
    get_report_lock,
    run_simulation,
)

log = logging.getLogger("echo.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Echo API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------- models
class SeedRequest(BaseModel):
    mode: Literal["csv", "oauth", "sample"]
    # Cap payload at ~1 MB so a malicious caller can't make us swallow huge
    # strings before pydantic gives up (CSV bodies in v1 are tiny).
    payload: str | None = Field(default=None, max_length=1_000_000)


class Archetype(BaseModel):
    id: str
    name: str
    share: int


class SeedResponse(BaseModel):
    audience_id: str
    name: str
    size: int
    archetypes: list[Archetype]


# Format guards — keep in lock-step with /seed (`aud_<10 hex>`) and
# /simulate/start (`sim_<10 hex>`). Defense-in-depth: parameterized SQL already
# blocks injection, but rejecting malformed ids at the boundary keeps DB
# lookups predictable and logs cleaner.
_AUDIENCE_ID_PATTERN = r"^aud_[0-9a-f]{10}$"
_SIMULATION_ID_PATTERN = r"^sim_[0-9a-f]{10}$"


class SimulateStartRequest(BaseModel):
    # v3 (CONTRACTS §13): draft cap raised 1000 → 3500 chars to support
    # PR posts, product launches, LinkedIn long-form, Twitter/X premium.
    draft: str = Field(min_length=1, max_length=3500)
    # v4 (CONTRACTS §16): `mode` is additive with default "business" so
    # legacy callers (no field) keep working unchanged. `audience_id` is now
    # optional at the wire level; the handler enforces "required when
    # mode=business" and surfaces a dedicated error code (§18). The pattern
    # still applies when a value is provided — None bypasses it (verified via
    # Context7 pydantic 2.x docs 2026-05-02).
    mode: Literal["business", "hypothetical"] = "business"
    audience_id: str | None = Field(default=None, pattern=_AUDIENCE_ID_PATTERN)
    # v5 (CONTRACTS §20, 2026-05-02): rounds range expanded [3,6] → [5,15] to
    # support the user-requested deeper-discourse mode. Per-sim budget cap was
    # raised in lock-step (swarm.MAX_LLM_CALLS 40 → 100) to fit
    # 6 archetypes × 15 rounds + 1 analysis + 1 report = 92 calls.
    rounds: int = Field(default=5, ge=5, le=15)
    # When true, the swarm runs one extra Gemini call with google_search
    # grounding before the rounds, so reactions are anchored to recent
    # real-world facts the swarm model would otherwise miss. Adds +1 to the
    # per-sim budget (93/100 worst case at rounds=15; 94/100 alongside Z1
    # persona genesis).
    web_grounding: bool = False
    # Z1 / v7 (CONTRACTS §27): persona pool size for the agentic engine.
    # Optional and additive — only takes effect when ECHO_ENGINE_VERSION="v7"
    # (server-side check in swarm.run_simulation). v6 callers may include this
    # field freely; the server ignores it. Range [30, 100] enforced here so
    # out-of-range bodies fail with HTTP 422 before any state is persisted.
    persona_count: int | None = Field(default=None, ge=30, le=100)


class SimulateStartResponse(BaseModel):
    simulation_id: str
    rounds: int
    status: str


class WorthReadingItem(BaseModel):
    label: str
    color: str
    tldr: str


class SuggestedRewrite(BaseModel):
    original: str
    rewrite: str


class AnalyzeResponse(BaseModel):
    simulation_id: str
    tldr: str
    suggested_rewrite: SuggestedRewrite
    worth_reading: list[WorthReadingItem]


# v2 additive: history list item + replay payload (read-only, zero LLM)
class HistoryItem(BaseModel):
    simulation_id: str
    draft: str
    rounds: int
    post_count: int
    tone: Literal["positive", "caution", "danger", "neutral"]
    mean_sentiment: float
    created_at: str
    has_analysis: bool
    # v4 (CONTRACTS §17): additive — defaults handled in db.list_simulations.
    mode: Literal["business", "hypothetical"] = "business"


class HistoryResponse(BaseModel):
    items: list[HistoryItem]


class ReplayAgent(BaseModel):
    id: str
    name: str
    handle: str
    archetype: Literal["skeptic", "enthusiast", "curious", "practitioner", "pedant", "lurker"]
    audience: Literal["target", "public"]
    # Z2 / v7 (CONTRACTS §25): rich persona fields surfaced on the wire for
    # v7 sims; empty/null for v6 sims and pre-Z1 replays. Old FE silently
    # ignores; new FE surfaces via tooltip / panel.
    bio: str = ""
    profession: str | None = None
    hot_buttons: list[str] | None = None
    # D1 (CONTRACTS §§37-40): per-persona cadence on the wire. Optional/null
    # for v6 sims and pre-D1 v7 sims (additive — never required).
    voice_cadence: str | None = None
    # G1 (CONTRACTS §§41-45): optional reaction-GIF tag picked by the persona
    # for this post. None for the vast majority of posts; FE renders non-null
    # tags as emoji + small CSS animation. Pre-G1 replays read None here.
    gif_reaction: str | None = None


class ReplayPost(BaseModel):
    id: str
    parent: str
    round: int
    agent: ReplayAgent
    sentiment: float
    text: str
    # v6 (CONTRACTS §§21-22): engagement signal. Defaults to 0 for legacy
    # rows whose stored payload predates the engagement engine. Replay
    # handler re-derives these on-the-fly using the deterministic algorithm
    # (same `(sim_id, post_id, round)` → same value, every time — L22).
    like_count: int = 0
    reply_count: int = 0


class ReplayAnalysis(BaseModel):
    tldr: str
    suggested_rewrite: SuggestedRewrite
    worth_reading: list[WorthReadingItem]


class ReplayResponse(BaseModel):
    simulation_id: str
    draft: str
    rounds: int
    posts: list[ReplayPost]
    analysis: ReplayAnalysis | None
    created_at: str
    # v4 (CONTRACTS §17): additive — defaults to "business" for legacy rows.
    mode: Literal["business", "hypothetical"] = "business"


# v3 (CONTRACTS §12): /report response models. Locked shapes.
class ReportAudienceReceptionItem(BaseModel):
    archetype: Literal["skeptic", "enthusiast", "curious", "practitioner", "pedant", "lurker"]
    tone: Literal["positive", "caution", "danger", "neutral"]
    summary: str
    representative_quote: str


class ReportRiskVector(BaseModel):
    label: str
    severity: Literal["low", "medium", "high"]
    detail: str


class ReportRewriteOption(BaseModel):
    label: str
    text: str
    rationale: str


class ReportBody(BaseModel):
    executive_summary: str
    verdict: Literal["ship", "revise", "rethink"]
    verdict_rationale: str
    audience_reception: list[ReportAudienceReceptionItem]
    risk_vectors: list[ReportRiskVector]
    rewrite_options: list[ReportRewriteOption]
    comparable_discourse: str


class ReportResponse(BaseModel):
    simulation_id: str
    draft: str
    audience_label: str
    rounds: int
    post_count: int
    generated_at: str
    model: str
    report: ReportBody
    # v4 (CONTRACTS §17): additive — defaults to "business" for legacy
    # cached report rows that pre-date the migration.
    mode: Literal["business", "hypothetical"] = "business"


# ---------------------------------------------------------------- endpoints
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.2.0"}


def _bad(status: int, code: str, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"detail": detail, "code": code})


@app.post("/seed", response_model=SeedResponse)
def seed(
    req: SeedRequest,
    uid: str = Depends(current_user_uid),
) -> SeedResponse:
    if req.mode == "csv" and not (req.payload and req.payload.strip()):
        raise _bad(400, "bad_payload", "CSV payload required for mode=csv")
    if req.mode == "oauth" and not (req.payload and req.payload.strip()):
        raise _bad(401, "oauth_failed", "oauth token rejected")

    audience_id = f"aud_{uuid.uuid4().hex[:10]}"
    if req.mode == "oauth":
        name = "X · @you"
        size = 4182
    elif req.mode == "csv":
        name = "Custom · uploaded"
        size = 1000
    else:
        name = "Notion · core"
        size = 8420

    archetypes = default_audience_archetypes()
    insert_audience(audience_id, uid, name, size, archetypes)
    return SeedResponse(
        audience_id=audience_id,
        name=name,
        size=size,
        archetypes=[Archetype(**a) for a in archetypes],
    )


@app.post("/simulate/start", response_model=SimulateStartResponse)
def simulate_start(
    req: SimulateStartRequest,
    uid: str = Depends(current_user_uid),
) -> SimulateStartResponse:
    # v4 (CONTRACTS §§16-19):
    #   - business    → audience_id REQUIRED, looked up via get_audience(); 404 if missing.
    #   - hypothetical → audience_id IGNORED, persisted as the GENERAL_PUBLIC_AUDIENCE
    #                    sentinel id so the schema's NOT NULL constraint stays satisfied
    #                    without a destructive table rebuild. Routing on `mode` (not on
    #                    audience_id presence) keeps the read path unambiguous.
    if req.mode == "business":
        if not req.audience_id:
            raise _bad(
                400,
                "audience_id_required_for_business_mode",
                "audience_id is required when mode=business",
            )
        aud = get_audience(req.audience_id, uid)
        if not aud:
            raise _bad(404, "unknown_audience", "audience not found")
        stored_audience_id = req.audience_id
    else:  # hypothetical
        stored_audience_id = GENERAL_PUBLIC_AUDIENCE["id"]

    sim_id = f"sim_{uuid.uuid4().hex[:10]}"
    # Persist both feature flags on the sim row so /simulate/stream can plumb
    # them through to run_simulation without an extra request body.
    #   - web_grounding: enables the google_search pre-call (default 0).
    #   - persona_count: Z1 / v7 persona pool size; NULL for v6 sims (column
    #     added by db.init_db migration).
    insert_simulation(
        sim_id,
        uid,
        stored_audience_id,
        req.draft,
        req.rounds,
        mode=req.mode,
        web_grounding=req.web_grounding,
        persona_count=req.persona_count,
    )
    return SimulateStartResponse(simulation_id=sim_id, rounds=req.rounds, status="running")


@app.get("/simulate/stream")
async def simulate_stream(
    simulation_id: str = Query(..., pattern=_SIMULATION_ID_PATTERN),
    uid: str = Depends(current_user_uid_from_query),
) -> EventSourceResponse:
    sim = get_simulation(simulation_id, uid)
    if not sim:
        raise _bad(404, "unknown_simulation", "simulation not found")
    # v4 (CONTRACTS §§16-19): hypothetical-mode sims weren't bound to a user
    # audience profile — short-circuit to GENERAL_PUBLIC_AUDIENCE so /simulate/stream
    # works without a real row in the audiences table. Business-mode lookups
    # use get_audience_unscoped because we already verified ownership of the
    # parent simulation via get_simulation(simulation_id, uid) above.
    sim_mode = sim.get("mode") if sim.get("mode") in ("business", "hypothetical") else "business"
    if sim_mode == "hypothetical":
        audience = GENERAL_PUBLIC_AUDIENCE
    else:
        audience = get_audience_unscoped(sim["audience_id"])
        if not audience:
            raise _bad(404, "unknown_audience", "audience not found")

    draft = sim["draft"]
    rounds = int(sim["rounds"])
    # Stored as INTEGER 0/1 in SQLite — cast to bool. Defensive default for
    # rows written before the web_grounding migration ran.
    web_grounding = bool(sim.get("web_grounding") or 0)
    # Z1 / v7: surface the persisted persona_count (NULL for v6 sims). The
    # column was added by an idempotent ALTER TABLE migration, so older sim
    # rows transparently read back as None here.
    persona_count_raw = sim.get("persona_count") if isinstance(sim, dict) else None
    persona_count: int | None = (
        int(persona_count_raw)
        if isinstance(persona_count_raw, int)
        or (isinstance(persona_count_raw, str) and persona_count_raw.isdigit())
        else None
    )

    async def event_gen():
        try:
            async for evt in run_simulation(
                sim_id=simulation_id,
                draft=draft,
                audience=audience,
                rounds=rounds,
                mode=sim_mode,
                web_grounding=web_grounding,
                persona_count=persona_count,
            ):
                event_name: str = evt.get("event", "message")
                data: Any = evt.get("data", {})

                if event_name == "round":
                    insert_round_event(simulation_id, int(data["round"]), data)
                    yield {"event": "round", "data": json.dumps(data)}
                elif event_name == "_analysis":
                    payload = {"simulation_id": simulation_id, **data}
                    upsert_analysis(simulation_id, payload)
                    # Don't emit to client — sentinel for persistence only.
                    continue  # skip the sleep — nothing to flush
                elif event_name == "grounding":
                    # CONTRACTS v8 §31: pass through the loading-state event
                    # so FE can show a "searching the web…" banner during the
                    # ~22s pre-call window. NOT persisted to round_events —
                    # per §33, replay payloads intentionally exclude pre-round
                    # events (the round_events table stores per-round
                    # cumulative posts, not pre-round metadata).
                    yield {"event": "grounding", "data": json.dumps(data)}
                elif event_name == "done":
                    yield {"event": "done", "data": json.dumps(data)}
                elif event_name == "error":
                    yield {"event": "error", "data": json.dumps(data)}
                else:
                    yield {"event": event_name, "data": json.dumps(data)}
                # Yield control back to the loop so sse-starlette can flush this
                # frame to the wire before the next round's gather() blocks.
                # Defensive: sse-starlette 2.x already flushes per-yield, but
                # this prevents any host/proxy coalescing during fast rounds.
                await asyncio.sleep(0)
        except Exception as exc:  # noqa: BLE001
            log.exception("event_gen crashed: %r", exc)
            yield {
                "event": "error",
                "data": json.dumps(
                    {"message": "internal error", "code": "internal_error"}
                ),
            }

    # X-Accel-Buffering=no tells nginx (and any nginx-flavored proxy) to disable
    # response buffering on this stream; Cache-Control no-transform stops gzip
    # middleware from coalescing events. Verified harmless against Next.js's
    # rewrite proxy (measured live during this fix).
    return EventSourceResponse(
        event_gen(),
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
        },
    )


@app.get("/analyze", response_model=AnalyzeResponse)
def analyze(
    simulation_id: str = Query(..., pattern=_SIMULATION_ID_PATTERN),
    uid: str = Depends(current_user_uid),
) -> AnalyzeResponse:
    sim = get_simulation(simulation_id, uid)
    if not sim:
        raise _bad(404, "unknown_simulation", "simulation not found")

    cached = get_analysis(simulation_id)
    if cached is None:
        raise _bad(409, "analysis_pending", "analysis not yet computed; finish the stream first")

    return AnalyzeResponse(
        simulation_id=cached.get("simulation_id", simulation_id),
        tldr=cached["tldr"],
        suggested_rewrite=SuggestedRewrite(**cached["suggested_rewrite"]),
        worth_reading=[WorthReadingItem(**w) for w in cached["worth_reading"]],
    )


# ----------------------------------------------------- v2 additive endpoints
# Both endpoints below are read-only — ZERO LLM calls (per .team/RULES.md R2).
# Wire shape locked in CONTRACTS.md §8/§9. v1 endpoints above are untouched.

@app.get("/history", response_model=HistoryResponse)
def history(
    limit: int = Query(default=50, ge=1, le=200),
    uid: str = Depends(current_user_uid),
) -> HistoryResponse:
    try:
        items = list_simulations(uid, limit)
        return HistoryResponse(items=[HistoryItem(**it) for it in items])
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("/history failed: %r", exc)
        raise _bad(500, "internal_error", "history read failed")


# v3 (CONTRACTS §12, §14): per-sim concurrency guard for /report lives in
# swarm.py so the auto-report fire-and-forget triggered at end-of-sim AND this
# HTTP handler share one mutex per sim_id. See `swarm.get_report_lock`.

# Wait this long for a sim's /report mutex before giving up and returning 409.
# Tuning: a thinking-model call typically lands in 5–20s, with rare 30s+
# excursions on level=high. 30s is the goldilocks ceiling — long enough to
# absorb the in-flight call's natural finish, short enough that the
# Next.js fetch retry UX still feels responsive.
_REPORT_LOCK_TIMEOUT = 30.0


@app.post("/report", response_model=ReportResponse)
async def report(
    simulation_id: str = Query(..., pattern=_SIMULATION_ID_PATTERN),
    regenerate: bool = Query(default=False),
    uid: str = Depends(current_user_uid),
) -> ReportResponse:
    sim = get_simulation(simulation_id, uid)
    if not sim:
        raise _bad(404, "unknown_simulation", "simulation not found")

    # Cache hit path: cheap return when not regenerating. Even on a multi-click
    # race, the second caller short-circuits here once the first persists.
    if not regenerate:
        cached = get_report(simulation_id)
        if cached is not None:
            try:
                return ReportResponse(**cached)
            except Exception as exc:  # noqa: BLE001
                # Persisted row malformed (e.g. wrote with old shape). Fall
                # through to regenerate rather than 500.
                log.warning("/report cached row malformed for %s: %r — regenerating", simulation_id, exc)

    # v3 race fix: rather than 409-ing immediately when the per-sim lock is
    # held, *wait* for it (cap at _REPORT_LOCK_TIMEOUT). The first caller does
    # the thinking-model call; the second caller wakes up, re-checks the cache
    # inside the lock, and returns the freshly persisted row — so the user gets
    # a successful report instead of an error and we spend exactly one Gemini
    # call. Verified against Python 3.14.4 asyncio docs (May 2026):
    # asyncio.Lock has no timeout kwarg; wrap acquire() in asyncio.wait_for().
    lock = await get_report_lock(simulation_id)
    try:
        await asyncio.wait_for(lock.acquire(), timeout=_REPORT_LOCK_TIMEOUT)
    except asyncio.TimeoutError:
        # Lock held longer than the safety ceiling — likely a stuck thinking
        # call. Surface 409 so the frontend can offer a retry.
        raise _bad(409, "report_pending", "report still generating; try again shortly")

    try:
        # Double-check cache inside the lock — a competing call may have just
        # finished and persisted while we were waiting to acquire.
        if not regenerate:
            cached = get_report(simulation_id)
            if cached is not None:
                try:
                    return ReportResponse(**cached)
                except Exception:  # noqa: BLE001
                    pass

        try:
            payload = await generate_report(simulation_id)
        except ReportSimNotFoundError:
            # Race: sim was deleted between our pre-check and generate. 404.
            raise _bad(404, "unknown_simulation", "simulation not found")
        except GeminiUnavailableError as exc:
            log.warning("/report gemini upstream failed for %s: %s", simulation_id, exc)
            raise HTTPException(
                status_code=502,
                detail={"detail": "thinking model unavailable", "code": "gemini_unavailable"},
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("/report failed for %s: %r", simulation_id, exc)
            raise _bad(500, "internal_error", "report generation failed")

        try:
            upsert_report(simulation_id, payload, payload.get("model", ""))
        except Exception as exc:  # noqa: BLE001
            # Non-fatal: still serve the freshly generated report — the next
            # /report call will just regenerate. Log loud.
            log.exception("/report upsert failed for %s: %r", simulation_id, exc)

        try:
            return ReportResponse(**payload)
        except Exception as exc:  # noqa: BLE001
            log.exception("/report response shape invalid for %s: %r", simulation_id, exc)
            raise _bad(500, "internal_error", "report response shape invalid")
    finally:
        lock.release()


@app.get("/simulate/replay", response_model=ReplayResponse)
def simulate_replay(
    simulation_id: str = Query(..., pattern=_SIMULATION_ID_PATTERN),
    uid: str = Depends(current_user_uid),
) -> ReplayResponse:
    try:
        full = get_simulation_full(simulation_id, uid)
        if full is None:
            raise _bad(404, "unknown_simulation", "simulation not found")

        analysis_obj: ReplayAnalysis | None = None
        analysis_dict = full.get("analysis")
        if isinstance(analysis_dict, dict):
            try:
                analysis_obj = ReplayAnalysis(
                    tldr=analysis_dict["tldr"],
                    suggested_rewrite=SuggestedRewrite(**analysis_dict["suggested_rewrite"]),
                    worth_reading=[WorthReadingItem(**w) for w in analysis_dict["worth_reading"]],
                )
            except (KeyError, TypeError, ValueError) as exc:
                # Persisted analysis is malformed — surface as null rather than 500.
                log.warning("replay: skipping malformed analysis for %s: %r", simulation_id, exc)
                analysis_obj = None

        mode_raw = full.get("mode")
        mode = mode_raw if mode_raw in ("business", "hypothetical") else "business"

        # Z2 / v7 (CONTRACTS §29): replay routes on whether the persisted
        # round_events JSON carries `persona_actions` (v7 — LLM-emergent
        # likes already in posts; just render) vs. v6 (deterministic
        # re-derivation via attach_engagement). The cheapest, most robust
        # signal is the `personas` table: non-empty rows for the sim →
        # genesis ran → this is a v7 sim. v6 sims never write to personas.
        posts_raw: list[dict[str, Any]] = list(full.get("posts") or [])
        is_v7_sim = bool(get_personas(full["simulation_id"]))
        if posts_raw and not is_v7_sim:
            # v6 deterministic re-derivation. Same (sim_id, post_id, round)
            # → same like_counts on every replay (L22).
            final_round = max(int(p.get("round", 0) or 0) for p in posts_raw)
            # Ownership already verified by get_simulation_full(sim_id, uid)
            # above; the unscoped lookups here are safe and avoid a redundant
            # uid filter (the parent sim's uid trivially matches).
            sim_row = get_simulation_unscoped(full["simulation_id"])
            if mode == "hypothetical":
                replay_audience = GENERAL_PUBLIC_AUDIENCE
            elif sim_row and sim_row.get("audience_id"):
                replay_audience = (
                    get_audience_unscoped(sim_row["audience_id"]) or GENERAL_PUBLIC_AUDIENCE
                )
            else:
                replay_audience = GENERAL_PUBLIC_AUDIENCE
            attach_engagement(
                posts_raw,
                sim_id=full["simulation_id"],
                current_round=final_round,
                audience=replay_audience,
            )
        # v7 path: posts already carry like_count + reply_count from the
        # persisted round_event JSON (engine wrote them at SSE emit time).
        # Replay reads bytes-for-bytes from disk — Gate 6 replay parity.

        return ReplayResponse(
            simulation_id=full["simulation_id"],
            draft=full["draft"],
            rounds=int(full["rounds"]),
            posts=[ReplayPost(**p) for p in posts_raw],
            analysis=analysis_obj,
            created_at=full["created_at"],
            mode=mode,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("/simulate/replay failed: %r", exc)
        raise _bad(500, "internal_error", "replay read failed")
