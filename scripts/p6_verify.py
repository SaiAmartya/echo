#!/usr/bin/env python
"""P6 verification driver — runs a hypothetical sim end-to-end and reports
sentiment distribution + sample reactions + report verdict.

Usage:
    python scripts/p6_verify.py "What if the US invaded Canada?" [rounds=3] [out=/tmp/scenA.json]
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Any

import httpx

BASE = "http://127.0.0.1:8000"


async def run_one(draft: str, rounds: int, out_path: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=180.0) as cx:
        # Register sim
        r = await cx.post(
            f"{BASE}/simulate/start",
            json={"draft": draft, "mode": "hypothetical", "rounds": rounds},
        )
        r.raise_for_status()
        sim_id = r.json()["simulation_id"]
        print(f"  sim_id: {sim_id}")
        t0 = time.time()

        # Drive the SSE stream
        posts: list[dict[str, Any]] = []
        async with cx.stream(
            "GET",
            f"{BASE}/simulate/stream",
            params={"simulation_id": sim_id},
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
                        print(f"  round {d.get('round')}/{d.get('of')}: {len(posts)} cumulative posts")
                    elif cur_event == "done":
                        print(f"  done after {time.time()-t0:.1f}s")
                        break
                    elif cur_event == "error":
                        print(f"  ERROR: {d}")
                        return {"sim_id": sim_id, "error": d}

        # Compute distribution
        sents = [p["sentiment"] for p in posts]
        n = len(sents) or 1
        neg = sum(1 for s in sents if s < 0)
        pos = sum(1 for s in sents if s > 0)
        neu = sum(1 for s in sents if -0.1 <= s <= 0.1)
        mean = sum(sents) / n
        print(f"  distribution — neg<0:{neg} pos>0:{pos} neutral[-0.1,+0.1]:{neu}; mean={mean:+.3f}; total={len(sents)}")

        # By archetype
        by_arc: dict[str, list[float]] = {}
        for p in posts:
            by_arc.setdefault(p["agent"]["archetype"], []).append(p["sentiment"])
        print("  by-archetype mean:")
        for arc in ("skeptic", "enthusiast", "curious", "practitioner", "pedant", "lurker"):
            xs = by_arc.get(arc, [])
            if xs:
                print(f"    {arc:12} n={len(xs):2}  mean={sum(xs)/len(xs):+.3f}  range=[{min(xs):+.2f},{max(xs):+.2f}]")

        # Sample reactions — one per archetype
        print("  sample reactions (one per archetype):")
        seen: set[str] = set()
        samples: list[dict[str, Any]] = []
        for p in posts:
            a = p["agent"]["archetype"]
            if a in seen:
                continue
            seen.add(a)
            samples.append(p)
            print(f"    [{a:12} sent={p['sentiment']:+.2f}] {p['text']}")
            if len(seen) >= 6:
                break

        # /report
        report_payload: dict[str, Any] = {}
        for attempt in range(20):
            r = await cx.post(f"{BASE}/report", params={"simulation_id": sim_id})
            if r.status_code == 200:
                report_payload = r.json()
                break
            if r.status_code == 409:
                await asyncio.sleep(2)
                continue
            print(f"  /report HTTP {r.status_code}: {r.text[:200]}")
            break
        verdict = report_payload.get("report", {}).get("verdict")
        exec_summary = report_payload.get("report", {}).get("executive_summary", "")[:240]
        print(f"  /report verdict: {verdict}")
        print(f"  exec_summary: {exec_summary}")

        out = {
            "sim_id": sim_id,
            "draft": draft,
            "rounds": rounds,
            "post_count": len(posts),
            "sents": sents,
            "mean": mean,
            "neg_count": neg,
            "pos_count": pos,
            "neutral_count": neu,
            "by_archetype_mean": {k: sum(v)/len(v) for k, v in by_arc.items()},
            "samples": [
                {"archetype": p["agent"]["archetype"], "sentiment": p["sentiment"], "text": p["text"]}
                for p in samples
            ],
            "verdict": verdict,
            "exec_summary": exec_summary,
            "elapsed": time.time() - t0,
        }
        with open(out_path, "w") as f:
            json.dump(out, f, indent=2)
        print(f"  saved {out_path}")
        return out


async def main() -> None:
    draft = sys.argv[1] if len(sys.argv) > 1 else "What if the US invaded Canada?"
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    out_path = sys.argv[3] if len(sys.argv) > 3 else "/tmp/p6_out.json"
    await run_one(draft, rounds, out_path)


if __name__ == "__main__":
    asyncio.run(main())
