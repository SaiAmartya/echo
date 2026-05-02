"""Echo FastAPI backend — Step 1 stubs.

Endpoints:
  POST /seed              — build a (canned) audience profile
  POST /simulate/start    — register a new simulation, return id
  GET  /simulate/stream   — Server-Sent Events feed of round progress
  GET  /analyze           — final aggregate (canned)

Real LLM calls land in Step 2. For Step 1 every response is canned so the
frontend round-trip can be verified end-to-end on localhost.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .canned import CANNED_FLAGS, CANNED_REPLIES, CANNED_REWRITE, NOTION_ARCHETYPES
from .db import (
    get_analysis,
    get_simulation,
    init_db,
    insert_audience,
    insert_simulation,
    upsert_analysis,
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Echo API", version="0.1.0", lifespan=lifespan)

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
    draft: str
    audience_id: str
    rounds: int = Field(default=5, ge=3, le=20)


class SimulateStartResponse(BaseModel):
    simulation_id: str
    rounds: int
    status: str


class AnalyzeReply(BaseModel):
    initials: str
    name: str
    handle: str
    text: str
    sentiment: float
    likely: int
    archetype: str


class AnalyzeFlag(BaseModel):
    title: str
    detail: str


class SentimentCounts(BaseModel):
    pos: int
    mix: int
    neg: int


class AnalyzeResponse(BaseModel):
    simulation_id: str
    ratio_risk: int
    tone: Literal["positive", "caution", "danger", "neutral"]
    sentiment: SentimentCounts
    rewrite: str
    replies: list[AnalyzeReply]
    flags: list[AnalyzeFlag]


# ---------------------------------------------------------------- endpoints
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.post("/seed", response_model=SeedResponse)
def seed(req: SeedRequest) -> SeedResponse:
    audience_id = f"aud_{uuid.uuid4().hex[:10]}"
    name = "Notion · core" if req.mode != "oauth" else "X · @you"
    size = 8420 if req.mode != "oauth" else 4182
    insert_audience(audience_id, name, size, NOTION_ARCHETYPES)
    return SeedResponse(audience_id=audience_id, name=name, size=size, archetypes=[Archetype(**a) for a in NOTION_ARCHETYPES])


@app.post("/simulate/start", response_model=SimulateStartResponse)
def simulate_start(req: SimulateStartRequest) -> SimulateStartResponse:
    sim_id = f"sim_{uuid.uuid4().hex[:10]}"
    insert_simulation(sim_id, req.audience_id, req.draft, req.rounds)
    return SimulateStartResponse(simulation_id=sim_id, rounds=req.rounds, status="running")


@app.get("/simulate/stream")
async def simulate_stream(simulation_id: str = Query(...)) -> EventSourceResponse:
    sim = get_simulation(simulation_id)
    if not sim:
        raise HTTPException(status_code=404, detail="simulation not found")

    rounds = int(sim["rounds"])

    async def event_gen():
        # Step 1: emit one fake round event per second so the frontend can
        # exercise its SSE handling. Step 2 swaps this for real LLM calls.
        for r in range(1, rounds + 1):
            await asyncio.sleep(1.0)
            agents = min(200, int(200 * r / rounds))
            yield {
                "event": "round",
                "data": json.dumps({
                    "round": r,
                    "of": rounds,
                    "agents_responded": agents,
                    "mean_sentiment": round(-0.08 + (r - 1) * 0.02, 2),
                }),
            }

        # Persist canned analysis so /analyze returns it.
        analysis = {
            "simulation_id": simulation_id,
            "ratio_risk": 64,
            "tone": "caution",
            "sentiment": {"pos": 92, "mix": 88, "neg": 67},
            "rewrite": CANNED_REWRITE,
            "replies": CANNED_REPLIES,
            "flags": CANNED_FLAGS,
        }
        upsert_analysis(simulation_id, analysis)

        yield {"event": "done", "data": json.dumps({"simulation_id": simulation_id})}

    return EventSourceResponse(event_gen())


@app.get("/analyze", response_model=AnalyzeResponse)
def analyze(simulation_id: str = Query(...)) -> AnalyzeResponse:
    sim = get_simulation(simulation_id)
    if not sim:
        raise HTTPException(status_code=404, detail="simulation not found")

    cached = get_analysis(simulation_id)
    if cached is None:
        # Stream not yet completed — return canned default anyway so the page
        # has something to show in the demo's hot-loop.
        cached = {
            "simulation_id": simulation_id,
            "ratio_risk": 64,
            "tone": "caution",
            "sentiment": {"pos": 92, "mix": 88, "neg": 67},
            "rewrite": CANNED_REWRITE,
            "replies": CANNED_REPLIES,
            "flags": CANNED_FLAGS,
        }
        upsert_analysis(simulation_id, cached)

    return AnalyzeResponse(**cached)
