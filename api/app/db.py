"""SQLite-backed persistence for Echo (Step 1 stubs)."""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DB_PATH = Path(os.environ.get("ECHO_DB_PATH", Path(__file__).resolve().parent.parent / "echo.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS audiences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    archetypes TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS simulations (
    id TEXT PRIMARY KEY,
    audience_id TEXT NOT NULL,
    draft TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS round_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    simulation_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analyses (
    simulation_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def insert_audience(audience_id: str, name: str, size: int, archetypes: list[dict[str, Any]]) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO audiences (id, name, size, archetypes) VALUES (?, ?, ?, ?)",
            (audience_id, name, size, json.dumps(archetypes)),
        )


def insert_simulation(sim_id: str, audience_id: str, draft: str, rounds: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO simulations (id, audience_id, draft, rounds) VALUES (?, ?, ?, ?)",
            (sim_id, audience_id, draft, rounds),
        )


def get_simulation(sim_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM simulations WHERE id = ?", (sim_id,)).fetchone()
        return dict(row) if row else None


def upsert_analysis(sim_id: str, payload: dict[str, Any]) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO analyses (simulation_id, payload) VALUES (?, ?)",
            (sim_id, json.dumps(payload)),
        )


def get_analysis(sim_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute("SELECT payload FROM analyses WHERE simulation_id = ?", (sim_id,)).fetchone()
        return json.loads(row["payload"]) if row else None
