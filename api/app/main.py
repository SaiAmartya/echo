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

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .db import (
    get_analysis,
    get_audience,
    get_simulation,
    init_db,
    insert_audience,
    insert_round_event,
    insert_simulation,
    upsert_analysis,
)
from .swarm import default_audience_archetypes, run_simulation

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
    payload: str | None = None


class Archetype(BaseModel):
    id: str
    name: str
    share: int


class SeedResponse(BaseModel):
    audience_id: str
    name: str
    size: int
    archetypes: list[Archetype]


class SimulateStartRequest(BaseModel):
    draft: str = Field(min_length=1, max_length=1000)
    audience_id: str
    rounds: int = Field(default=5, ge=3, le=6)


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


# ---------------------------------------------------------------- endpoints
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.2.0"}


def _bad(status: int, code: str, detail: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"detail": detail, "code": code})


@app.post("/seed", response_model=SeedResponse)
def seed(req: SeedRequest) -> SeedResponse:
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
    insert_audience(audience_id, name, size, archetypes)
    return SeedResponse(
        audience_id=audience_id,
        name=name,
        size=size,
        archetypes=[Archetype(**a) for a in archetypes],
    )


@app.post("/simulate/start", response_model=SimulateStartResponse)
def simulate_start(req: SimulateStartRequest) -> SimulateStartResponse:
    aud = get_audience(req.audience_id)
    if not aud:
        raise _bad(404, "unknown_audience", "audience not found")
    sim_id = f"sim_{uuid.uuid4().hex[:10]}"
    insert_simulation(sim_id, req.audience_id, req.draft, req.rounds)
    return SimulateStartResponse(simulation_id=sim_id, rounds=req.rounds, status="running")


@app.get("/simulate/stream")
async def simulate_stream(simulation_id: str = Query(...)) -> EventSourceResponse:
    sim = get_simulation(simulation_id)
    if not sim:
        raise _bad(404, "unknown_simulation", "simulation not found")
    audience = get_audience(sim["audience_id"])
    if not audience:
        raise _bad(404, "unknown_audience", "audience not found")

    draft = sim["draft"]
    rounds = int(sim["rounds"])

    async def event_gen():
        try:
            async for evt in run_simulation(
                sim_id=simulation_id,
                draft=draft,
                audience=audience,
                rounds=rounds,
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
def analyze(simulation_id: str = Query(...)) -> AnalyzeResponse:
    sim = get_simulation(simulation_id)
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
