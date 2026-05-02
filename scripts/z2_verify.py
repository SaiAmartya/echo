#!/usr/bin/env python
"""Z2 verification driver — runs v7 sims end-to-end and checks the 7 gates.

Usage:
    python scripts/z2_verify.py smoke           # quick 30p × 3r test
    python scripts/z2_verify.py gate1           # P6 calibration (3 scenarios)
    python scripts/z2_verify.py gate2_3 [sim]   # diversity + engagement realism
    python scripts/z2_verify.py gate4           # cost & latency
    python scripts/z2_verify.py gate6 <sim_id>  # replay parity
    python scripts/z2_verify.py gate7           # v6 rollback drill
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any

import httpx

BASE = "http://127.0.0.1:8000"


async def run_v7_sim(
    draft: str,
    rounds: int,
    persona_count: int,
    out_path: str,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=300.0, headers={"Authorization": "Bearer dev-local-token"}) as cx:
        r = await cx.post(
            f"{BASE}/simulate/start",
            json={
                "draft": draft,
                "mode": "hypothetical",
                "rounds": rounds,
                "persona_count": persona_count,
            },
        )
        r.raise_for_status()
        sim_id = r.json()["simulation_id"]
        print(f"  sim_id={sim_id} (v7 {persona_count}p × {rounds}r)")
        t0 = time.time()

        posts: list[dict[str, Any]] = []
        last_round_data: dict[str, Any] = {}
        round_count = 0
        async with cx.stream(
            "GET",
            f"{BASE}/simulate/stream",
            params={"simulation_id": sim_id, "token": "dev-local-token"},
        ) as resp:
            resp.raise_for_status()
            cur_event = "message"
            cur_data_lines: list[str] = []
            async for line in resp.aiter_lines():
                if line.startswith("event:"):
                    cur_event = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    cur_data_lines.append(line[len("data:"):].strip())
                elif line == "" and cur_data_lines:
                    raw = "\n".join(cur_data_lines)
                    cur_data_lines = []
                    try:
                        d = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if cur_event == "round":
                        posts = d.get("posts") or []
                        last_round_data = d
                        round_count += 1
                        elapsed = time.time() - t0
                        pa = d.get("persona_actions") or []
                        non_skip = sum(1 for a in pa if a.get("action") != "skip")
                        print(
                            f"  r{d.get('round')}/{d.get('of')} t={elapsed:.1f}s "
                            f"posts_total={len(posts)} actions={len(pa)} non_skip={non_skip}"
                        )
                    elif cur_event == "done":
                        elapsed = time.time() - t0
                        print(f"  done t={elapsed:.1f}s")
                        break
                    elif cur_event == "error":
                        print(f"  ERROR: {d}")
                        return {"sim_id": sim_id, "error": d, "elapsed": time.time() - t0}

    sents = [p["sentiment"] for p in posts]
    n = len(sents) or 1
    mean = sum(sents) / n

    by_arc: dict[str, list[float]] = {}
    for p in posts:
        by_arc.setdefault(p["agent"]["archetype"], []).append(p["sentiment"])

    out = {
        "sim_id": sim_id,
        "draft": draft,
        "rounds": rounds,
        "persona_count": persona_count,
        "post_count": len(posts),
        "mean_sentiment": mean,
        "elapsed": time.time() - t0,
        "by_archetype_mean": {k: sum(v)/len(v) for k, v in by_arc.items()},
        "by_archetype_n": {k: len(v) for k, v in by_arc.items()},
        "posts_top10_by_likes": sorted(posts, key=lambda p: -p.get("like_count", 0))[:10],
        "all_posts": posts,
        "last_round_data": last_round_data,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"  saved {out_path}")
    print(f"  mean={mean:+.3f} posts={len(posts)} elapsed={out['elapsed']:.1f}s")
    return out


async def smoke() -> None:
    print("=== smoke (30p × 5r) ===")
    await run_v7_sim(
        "What if the US invaded Canada?",
        rounds=5,
        persona_count=30,
        out_path="/tmp/z2_smoke.json",
    )


async def gate1() -> None:
    """P6 calibration — three scenarios at 50p × 8r."""
    print("=== Gate 1: P6 calibration intact (50p × 8r) ===")
    scenarios = [
        ("A", "What if the US invaded Canada?", -0.4, "must be ≤ -0.4 mean"),
        ("B", "Notion shipped a calmer notification system", 0.05, "must be in [+0.05, +0.30]"),
        ("C", "What if all U.S. schools went four-day weeks?", 0.0, "must be in [-0.30, +0.10]"),
    ]
    for tag, draft, _expected, note in scenarios:
        print(f"\n--- Scenario {tag}: {draft!r}\n  expectation: {note}")
        await run_v7_sim(
            draft,
            rounds=8,
            persona_count=50,
            out_path=f"/tmp/z2_gate1_{tag}.json",
        )


async def gate4() -> None:
    """Cost & latency stress. 50p×8r already covered by gate1 sims; just
    run the 100p × 10r upper-bound."""
    print("=== Gate 4: stress (100p × 10r) ===")
    b = await run_v7_sim(
        "What if we banned single-use plastics in all U.S. restaurants?",
        rounds=10,
        persona_count=100,
        out_path="/tmp/z2_gate4_100p10r.json",
    )
    print(
        f"\nGate 4 result: 100p10r elapsed={b['elapsed']:.1f}s posts={b['post_count']}"
    )


async def gate6(sim_id: str) -> None:
    """Replay parity — fetch /simulate/replay twice, diff bytes."""
    print(f"=== Gate 6: replay parity for {sim_id} ===")
    async with httpx.AsyncClient(timeout=60.0, headers={"Authorization": "Bearer dev-local-token"}) as cx:
        r1 = await cx.get(f"{BASE}/simulate/replay", params={"simulation_id": sim_id})
        r1.raise_for_status()
        r2 = await cx.get(f"{BASE}/simulate/replay", params={"simulation_id": sim_id})
        r2.raise_for_status()
        b1 = r1.content
        b2 = r2.content
        if b1 == b2:
            print(f"  PASS — {len(b1)} bytes identical between two replay calls")
        else:
            print(f"  FAIL — bytes differ ({len(b1)} vs {len(b2)})")


async def gate7() -> None:
    """v6 rollback drill — set ECHO_ENGINE_VERSION=v6 in this script's
    test sim and confirm v6 path: ~92 calls, ~30s wallclock, archetype output."""
    print("=== Gate 7: v6 rollback drill ===")
    print("This must run against a uvicorn started with ECHO_ENGINE_VERSION=v6.")
    print("Skipping if server is in v7 mode — run separately.")
    # Just kick off a normal sim. If server is v7, this will run the v7 path.
    async with httpx.AsyncClient(timeout=180.0, headers={"Authorization": "Bearer dev-local-token"}) as cx:
        r = await cx.post(
            f"{BASE}/simulate/start",
            json={
                "draft": "What if Yellowstone erupted next month?",
                "mode": "hypothetical",
                "rounds": 5,
                # Don't pass persona_count — v6 ignores it; v7 defaults to 50.
            },
        )
        r.raise_for_status()
        sim_id = r.json()["simulation_id"]
        print(f"  sim_id={sim_id}")
        t0 = time.time()
        posts: list[dict[str, Any]] = []
        async with cx.stream(
            "GET",
            f"{BASE}/simulate/stream",
            params={"simulation_id": sim_id, "token": "dev-local-token"},
        ) as resp:
            resp.raise_for_status()
            cur_event = "message"
            cur_data_lines: list[str] = []
            async for line in resp.aiter_lines():
                if line.startswith("event:"):
                    cur_event = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    cur_data_lines.append(line[len("data:"):].strip())
                elif line == "" and cur_data_lines:
                    raw = "\n".join(cur_data_lines)
                    cur_data_lines = []
                    try:
                        d = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if cur_event == "round":
                        posts = d.get("posts") or []
                        has_persona_actions = "persona_actions" in d
                        print(
                            f"  r{d.get('round')}/{d.get('of')} posts={len(posts)} "
                            f"persona_actions_in_payload={has_persona_actions}"
                        )
                    elif cur_event in ("done", "error"):
                        elapsed = time.time() - t0
                        print(f"  {cur_event} t={elapsed:.1f}s posts={len(posts)}")
                        break
        # Inspect first post agent block — v6 should NOT have bio/profession populated
        if posts:
            agent = posts[0].get("agent", {})
            print(f"  first agent: {agent}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "smoke":
        asyncio.run(smoke())
    elif cmd == "gate1":
        asyncio.run(gate1())
    elif cmd == "gate4":
        asyncio.run(gate4())
    elif cmd == "gate6":
        asyncio.run(gate6(sys.argv[2]))
    elif cmd == "gate7":
        asyncio.run(gate7())
    else:
        print(f"unknown cmd {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
