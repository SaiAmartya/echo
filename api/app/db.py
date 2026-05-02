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
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    archetypes TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audiences_user ON audiences(user_id);

CREATE TABLE IF NOT EXISTS simulations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    audience_id TEXT NOT NULL,
    draft TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_simulations_user ON simulations(user_id);

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

-- v3 (CONTRACTS §14): cached full reports, one per simulation.
CREATE TABLE IF NOT EXISTS reports (
    simulation_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)
        # v4 (CONTRACTS §§16-19): idempotent migration to add `mode` column to
        # simulations. New rows default to 'business' so legacy rows + legacy
        # callers without a mode field keep working unchanged. SQLite's
        # `ALTER TABLE ADD COLUMN` raises OperationalError("duplicate column
        # name: mode") on re-run; we swallow only that exact case.
        try:
            conn.execute(
                "ALTER TABLE simulations ADD COLUMN mode TEXT NOT NULL DEFAULT 'business'"
            )
            print("schema migration: mode column added to simulations")
        except sqlite3.OperationalError as e:
            if "duplicate column name" in str(e).lower():
                pass  # already migrated
            else:
                raise


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def insert_audience(
    audience_id: str,
    user_id: str,
    name: str,
    size: int,
    archetypes: list[dict[str, Any]],
) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO audiences (id, user_id, name, size, archetypes) "
            "VALUES (?, ?, ?, ?, ?)",
            (audience_id, user_id, name, size, json.dumps(archetypes)),
        )


def insert_simulation(
    sim_id: str,
    user_id: str,
    audience_id: str,
    draft: str,
    rounds: int,
    mode: str = "business",
) -> None:
    """Persist a new simulation row scoped to `user_id`.

    v4 (CONTRACTS §§16-19): `mode` is "business" (default, requires a real
    audience_id) or "hypothetical" (uses the GENERAL_PUBLIC_AUDIENCE sentinel).
    The `audience_id` column is stored verbatim; for hypothetical sims the
    caller passes the sentinel id so the schema's NOT NULL constraint stays
    satisfied without a destructive table rebuild. Routing on `mode` (not on
    audience_id presence) keeps the read path unambiguous.
    """
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO simulations (id, user_id, audience_id, draft, rounds, mode) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (sim_id, user_id, audience_id, draft, rounds, mode),
        )


def get_simulation(sim_id: str, user_id: str) -> dict[str, Any] | None:
    """Return a simulation row only if it belongs to `user_id`. None otherwise."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM simulations WHERE id = ? AND user_id = ?",
            (sim_id, user_id),
        ).fetchone()
        return dict(row) if row else None


def get_simulation_unscoped(sim_id: str) -> dict[str, Any] | None:
    """Internal lookup without user scoping — used by the swarm engine for
    auto-reports / streaming after the request handler has already verified
    ownership via get_simulation(sim_id, uid). Never call from user-facing
    handlers."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM simulations WHERE id = ?", (sim_id,)
        ).fetchone()
        return dict(row) if row else None


def get_simulation_full_unscoped(sim_id: str) -> dict[str, Any] | None:
    """Internal: same as get_simulation_full but skips user scoping. Used by
    the swarm engine's report generator. Never expose to handlers."""
    with get_conn() as conn:
        sim_row = conn.execute(
            "SELECT id, draft, rounds, mode, created_at FROM simulations WHERE id = ?",
            (sim_id,),
        ).fetchone()
        if not sim_row:
            return None

        latest = conn.execute(
            "SELECT round, payload FROM round_events WHERE simulation_id = ? "
            "ORDER BY round DESC, id DESC LIMIT 1",
            (sim_id,),
        ).fetchone()
        posts: list[dict[str, Any]] = []
        latest_round: int | None = None
        if latest:
            latest_round = int(latest["round"])
            try:
                payload = json.loads(latest["payload"])
                if isinstance(payload, dict):
                    raw_posts = payload.get("posts", [])
                    if isinstance(raw_posts, list):
                        posts = raw_posts
            except (TypeError, ValueError):
                posts = []

        analysis_row = conn.execute(
            "SELECT payload FROM analyses WHERE simulation_id = ?",
            (sim_id,),
        ).fetchone()
        analysis: dict[str, Any] | None = None
        if analysis_row:
            try:
                analysis = json.loads(analysis_row["payload"])
            except (TypeError, ValueError):
                analysis = None

    rounds = latest_round if latest_round is not None else int(sim_row["rounds"])

    mode_raw = sim_row["mode"] if "mode" in sim_row.keys() else None
    mode = mode_raw if mode_raw in ("business", "hypothetical") else "business"

    return {
        "simulation_id": sim_row["id"],
        "draft": sim_row["draft"],
        "rounds": rounds,
        "posts": posts,
        "analysis": analysis,
        "created_at": _iso_z(sim_row["created_at"]),
        "mode": mode,
    }


def get_simulation_owner(sim_id: str) -> str | None:
    """Internal: return the owning user_id for a sim, or None if it doesn't exist.
    Used by the swarm engine when it generates auto-reports server-side without
    a request scope. Should NOT be exposed to user-facing handlers."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT user_id FROM simulations WHERE id = ?",
            (sim_id,),
        ).fetchone()
        return row["user_id"] if row else None


def get_audience(audience_id: str, user_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, size, archetypes FROM audiences WHERE id = ? AND user_id = ?",
            (audience_id, user_id),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "size": row["size"],
            "archetypes": json.loads(row["archetypes"]),
        }


def get_audience_unscoped(audience_id: str) -> dict[str, Any] | None:
    """Internal lookup without user scoping — used by the swarm engine when
    streaming a sim it has already authorized via get_simulation(sim_id, uid).
    Never call from user-facing handlers."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, size, archetypes FROM audiences WHERE id = ?",
            (audience_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "size": row["size"],
            "archetypes": json.loads(row["archetypes"]),
        }


def insert_round_event(sim_id: str, round_no: int, payload: dict[str, Any]) -> None:
    """Persist the cumulative `posts` payload for one round so the SSE stream
    can be replayed verbatim on reconnect (CONTRACTS.md §3)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO round_events (simulation_id, round, payload) VALUES (?, ?, ?)",
            (sim_id, round_no, json.dumps(payload)),
        )


def get_round_events(sim_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT round, payload FROM round_events WHERE simulation_id = ? ORDER BY round ASC, id ASC",
            (sim_id,),
        ).fetchall()
        return [
            {"round": r["round"], "payload": json.loads(r["payload"])}
            for r in rows
        ]


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


# ---------------------------------------------------------------- v3 reports
def get_report(sim_id: str) -> dict[str, Any] | None:
    """Return the cached full report for a sim, or None.

    Returned dict is the full §12 wire shape:
      { simulation_id, draft, audience_label, rounds, post_count,
        generated_at, model, report }
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload, model, generated_at FROM reports WHERE simulation_id = ?",
            (sim_id,),
        ).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        # Persisted payload already carries `model` + `generated_at`; trust the
        # row columns as authoritative on read.
        payload["model"] = row["model"]
        payload["generated_at"] = _iso_z(row["generated_at"])
        return payload


def upsert_report(sim_id: str, payload: dict[str, Any], model: str) -> None:
    """Persist (or replace) the full report row for a sim.

    `generated_at` defaults to `datetime('now')` on INSERT — but on REPLACE we
    explicitly stamp it so a regenerate updates the timestamp.
    """
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO reports (simulation_id, payload, model, generated_at) "
            "VALUES (?, ?, ?, datetime('now'))",
            (sim_id, json.dumps(payload), model),
        )


# ---------------------------------------------------------------- v2 helpers
def _tone_from_mean(mean: float | None, has_analysis: bool) -> str:
    """Tone bucket per CONTRACTS v2 §8.

    positive  → mean >=  0.20
    caution   → mean ∈ [-0.10, 0.20)
    danger    → mean <  -0.10
    neutral   → analysis missing / sim incomplete (or no posts at all)
    """
    if not has_analysis or mean is None:
        return "neutral"
    if mean >= 0.20:
        return "positive"
    if mean >= -0.10:
        return "caution"
    return "danger"


def _iso_z(ts: str | None) -> str:
    """SQLite stores `datetime('now')` as 'YYYY-MM-DD HH:MM:SS' (UTC).
    Render as ISO-8601 with trailing Z so frontends can `new Date(...)` it."""
    if not ts:
        return ""
    if "T" in ts and ts.endswith("Z"):
        return ts
    return ts.replace(" ", "T") + "Z"


def _latest_round_payload(conn: sqlite3.Connection, sim_id: str) -> dict[str, Any] | None:
    """Highest-round persisted round_event payload for a sim. None if no events."""
    row = conn.execute(
        "SELECT payload FROM round_events WHERE simulation_id = ? "
        "ORDER BY round DESC, id DESC LIMIT 1",
        (sim_id,),
    ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["payload"])
    except (TypeError, ValueError):
        return None


def list_simulations(user_id: str, limit: int) -> list[dict[str, Any]]:
    """List simulations newest first with analysis-derived stats, scoped to one
    user.

    Per CONTRACTS v2 §8: each row carries a 240-char draft preview, post_count
    and mean_sentiment computed from the latest cumulative `round_events.payload`,
    and a tone bucket via `_tone_from_mean`.
    """
    if limit < 1:
        limit = 1
    if limit > 200:
        limit = 200

    items: list[dict[str, Any]] = []
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT s.id          AS simulation_id,
                   s.draft       AS draft,
                   s.rounds      AS rounds,
                   s.mode        AS mode,
                   s.created_at  AS created_at,
                   a.payload     AS analysis_payload
            FROM simulations s
            LEFT JOIN analyses a ON a.simulation_id = s.id
            WHERE s.user_id = ?
            ORDER BY s.rowid DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

        for row in rows:
            sim_id = row["simulation_id"]
            payload = _latest_round_payload(conn, sim_id)
            posts = payload.get("posts", []) if isinstance(payload, dict) else []
            post_count = len(posts)

            sentiments = [
                float(p["sentiment"])
                for p in posts
                if isinstance(p, dict) and isinstance(p.get("sentiment"), (int, float))
            ]
            mean_sentiment = (sum(sentiments) / len(sentiments)) if sentiments else 0.0
            mean_sentiment = round(mean_sentiment, 2)

            has_analysis = row["analysis_payload"] is not None
            # neutral when analysis missing OR sim has no posts yet
            mean_for_tone = mean_sentiment if (has_analysis and post_count > 0) else None
            tone = _tone_from_mean(mean_for_tone, has_analysis and post_count > 0)

            draft_full = row["draft"] or ""
            draft_preview = draft_full[:240]

            # v4: `mode` defaults to 'business' for legacy rows (the column has
            # a DEFAULT in the migration, but be defensive against pre-migration
            # databases or tampered rows).
            mode_raw = row["mode"] if "mode" in row.keys() else None
            mode = mode_raw if mode_raw in ("business", "hypothetical") else "business"

            items.append(
                {
                    "simulation_id": sim_id,
                    "draft": draft_preview,
                    "rounds": int(row["rounds"]),
                    "post_count": post_count,
                    "tone": tone,
                    "mean_sentiment": mean_sentiment,
                    "created_at": _iso_z(row["created_at"]),
                    "has_analysis": has_analysis,
                    "mode": mode,
                }
            )
    return items


def get_simulation_full(sim_id: str, user_id: str) -> dict[str, Any] | None:
    """Return the full final state of a simulation for /simulate/replay,
    scoped to `user_id`.

    Shape (CONTRACTS v2 §9):
      { simulation_id, draft, rounds, posts[], analysis|None, created_at }

    `rounds` is the highest persisted round number (or the registered round count
    if the sim has no events yet — for "running but nothing emitted" sims).
    `posts` is the cumulative list from the highest-round payload (already sorted
    server-side at write time).
    """
    with get_conn() as conn:
        sim_row = conn.execute(
            "SELECT id, draft, rounds, mode, created_at FROM simulations "
            "WHERE id = ? AND user_id = ?",
            (sim_id, user_id),
        ).fetchone()
        if not sim_row:
            return None

        latest = conn.execute(
            "SELECT round, payload FROM round_events WHERE simulation_id = ? "
            "ORDER BY round DESC, id DESC LIMIT 1",
            (sim_id,),
        ).fetchone()
        posts: list[dict[str, Any]] = []
        latest_round: int | None = None
        if latest:
            latest_round = int(latest["round"])
            try:
                payload = json.loads(latest["payload"])
                if isinstance(payload, dict):
                    raw_posts = payload.get("posts", [])
                    if isinstance(raw_posts, list):
                        posts = raw_posts
            except (TypeError, ValueError):
                posts = []

        analysis_row = conn.execute(
            "SELECT payload FROM analyses WHERE simulation_id = ?",
            (sim_id,),
        ).fetchone()
        analysis: dict[str, Any] | None = None
        if analysis_row:
            try:
                analysis = json.loads(analysis_row["payload"])
            except (TypeError, ValueError):
                analysis = None

    rounds = latest_round if latest_round is not None else int(sim_row["rounds"])

    # v4: surface mode in the projection. Defensive fallback for any row
    # written before the migration ran.
    mode_raw = sim_row["mode"] if "mode" in sim_row.keys() else None
    mode = mode_raw if mode_raw in ("business", "hypothetical") else "business"

    return {
        "simulation_id": sim_row["id"],
        "draft": sim_row["draft"],
        "rounds": rounds,
        "posts": posts,
        "analysis": analysis,
        "created_at": _iso_z(sim_row["created_at"]),
        "mode": mode,
    }
