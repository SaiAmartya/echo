# LEARNINGS.md — team-lead handoff notes

Lessons from the first run of the `echo-hackathon` team. Written 2026-05-02 by team-lead@echo-hackathon (claude-opus-4-7) before a planned compaction. Read this before resuming as team-lead in a future session — the pivot the user mentioned may change the *what* but most of these address the *how*.

---

## L1 — Always lock the wire contract BEFORE parallel work

`.team/CONTRACTS.md` v1 / v2 / v3 — each LOCKED before backend + frontend agents went parallel. This is the single most leveraged decision. Each version was *additive* (v3 didn't break v1 or v2 shapes). Without this, FE and BE drift in <30 minutes and you spend 2 hours reconciling.

**How:** lead writes the contract themselves before delegating, even if it takes 10 minutes. Saves hours.

## L2 — R1 (verify libs via Context7/WebSearch) is non-negotiable

Backend-engineer-3 verified `gemini-3-flash-preview` is a **single unified model** with thinking enabled via `GenerateContentConfig.thinking_config`, not a separate `gemini-3-flash-thinking` ID. Caught via Context7 + ai.google.dev/gemini-3, NOT from training memory. Saved us from chasing a phantom model ID.

Same for SDK call signatures, asyncio Lock semantics, sse-starlette flushing, Next.js rewrites. **Every time an agent verified, they were right; every time someone tried to "remember", they were one model-name shift behind reality.**

## L3 — Spawn template selection is load-bearing

`subagent_type: "e2e-test-runner"` is *misconfigured for echo* — it's the TidalTasks Vitest/Playwright/Maestro orchestrator, no chrome MCP, no SendMessage, no Task tools. Spawning it for echo blocks the agent immediately.

**Use `general-purpose` for any browser automation on echo.** R10 in `.team/RULES.md`. This rule was earned the hard way (twice).

## L4 — Idle pings ≠ stopped agents

The team system auto-emits `{type:"idle_notification"}` after every agent turn ends. **It is normal protocol noise, not a failure.** Per the agent-teams docs: don't react unless you have new work to assign.

Spent significant attention early on misreading these as the team "stopping". Don't.

## L5 — Duplicate-dispatch ghosts are a thing

Multiple times I watched the system re-fire a `task_assignment` to a recently-completed agent. The agent's correct response is to no-op and point to the existing artifact. Several agents (debugger, frontend-engineer, backend-engineer-2, browser-tester-2) all caught this gracefully. Don't panic when you see it.

## L6 — Despawn aggressively, respawn fresh

User directive that proved correct: after each phase, shutdown the agent, spawn a *fresh* one for the next task. Each new agent gets a clean context, reads `.team/RULES.md` and `.team/CONTRACTS.md` cold, and works against the *current* state of main rather than a 1-hour-stale view.

Cost: ~30s of "read the rules" overhead per spawn. Benefit: no stale-context bugs across 12+ agent generations.

## L7 — R9 human QA at every phase boundary is non-negotiable

The user added this rule mid-flight after I tried to roll forward without it. **It catches what wire tests + typechecks cannot:** "this isn't readable", "this feels generic", "responses are too short", "I want this button removed". Three of the most-impactful changes in this project came from human QA, not automation.

The human gate is also the most expensive bottleneck in iteration speed. Strategy: make the QA script copy-pasteable, surface 3-5 specific things to verify, give cost transparency, ask explicit yes/no.

## L8 — The R6 push policy: agents commit, lead batches the push

Engineers commit locally; only team-lead pushes to GitHub. Batches related changes (e.g., backend E1 + frontend E2 + audit E3 + lead's manual fix → one push). Avoids partial states on `main`.

When the user explicitly wanted a push, do it inline. Otherwise wait for phase-boundary.

## L9 — Process-global concurrency, per-instance counters

Security-auditor caught a real R2 violation: `BudgetCounter` had its own `asyncio.Semaphore(6)` per dataclass instance. Two parallel sims meant 12 in-flight calls upstream, not 6. Fixed by lifting the semaphore to module-level lazy singleton; per-sim *counter* (the budget itself) stays per-instance.

**General rule:** counters that bound *spend* are per-resource (per-sim). Semaphores that bound *concurrency* are per-process. They look similar; they're different.

## L10 — Server-side flushing is rarely the SSE bug

When user reported "rounds collapse into one frame", I lined up four hypotheses: (1) backend yield in wrong place, (2) sse-starlette buffering, (3) Next.js rewrite buffering, (4) React batching. Debugger discovered server-side cadence was already 1.6s/3.2s/5.0s with `curl -N`, both direct and through Next proxy. **Bug was 100% frontend** — `setRound`/`setPosts` calls in same tick collapsed into one paint.

Fix: paced ingest queue with 1.2s minimum gap + 2s linger before redirect. Same pattern applies to any LLM-streaming UI: pace the *consumption* on the client even if the server is streaming correctly. It also makes the demo more impressive.

## L11 — Cache-check INSIDE the lock

The `/report` endpoint's correct pattern: acquire lock with timeout → re-check cache → if absent, generate → upsert → release. The cache-check inside the lock is the key — the second waiter benefits from the first waiter's work without re-running.

Combined with: fire-and-forget auto-gen at end of `run_simulation` so the cache is usually pre-warmed. Plus 30s `wait_for(lock.acquire())` so React strict-mode double-mount no longer 409s.

This is the canonical pattern for "expensive idempotent work behind a per-key concurrency guard."

## L12 — Budget tracking matters; overruns are sometimes correct

Tracked actual LLM spend per phase in `.team/STATUS.md` budget ledger. Caught one overrun: debugger burned 57 calls on a 38-budget diagnosis. Acceptable because the overrun bought correctly-identified root cause. **Track it, don't bury it.** Hackathon ceiling: 300 calls; we ended around 150 with full feature set.

## L13 — Default-show vs click-to-show is a UX call, not a layout call

The "See full report" button on `/results` was technically correct but framed the value as optional. User cut it: "by default the full report should be generated and that page should be shown". Lesson: **if a feature is the killer-feature, make the killer-flow the default flow.** No buttons that gatekeep the punchline.

This kind of pivot is cheap when CONTRACTS.md is locked and additive — we deleted `/results` and rerouted in 4 file edits + 1 directory removal.

## L14 — MiroFish-shaped scope discipline

We're inspired by MiroFish (a 58k-star multi-month project). For a hackathon: clone the *spirit* (multi-archetype × multi-round simulated reactions, dogpile dynamics, ReportAgent), reject the *engineering bulk* (GraphRAG, Zep memory, OASIS engine, multi-platform routing). Hard rule in `docs/MIROFISH-NOTES.md`: "do NOT switch to OASIS / Zep / GraphRAG mid-build."

## L15 — Verification gap honesty

We never had a successful browser-driven E2E test until the user manually connected the Claude Chrome extension. **I documented this gap clearly in `.team/STATUS.md`** rather than papering over it. Wire tests + human QA carried the project. The honesty made the user trust me more, not less.

---

## Architectural notes specific to echo (may inform the upcoming pivot)

- **6 archetypes × N rounds × 1 call/archetype/round = 6N calls.** R=5 → 30 + 1 analysis + 1 report = 32 calls/sim ≈ $0.005. Headroom under the 40-call cap is real.
- **Mixed-model architecture is correct.** Flash-Lite for per-archetype reactions (cheap, in-character is fine), Gemini 3 Flash Preview (thinking) for analysis + full report (needs full thread context, accurate aggregation). Don't unify; the latency / cost / quality tradeoff differs sharply.
- **The `parent` post-id chain IS a relationship graph.** SwarmThread visualizes it without any GraphRAG. Don't over-engineer.
- **Cumulative posts (not deltas) on the wire.** Lets the SwarmThread component render the same way for live + replay. Idempotent.
- **Per-persona "vibe strings" is the next big quality win** (banked in BACKLOG F1). Same budget, materially less generic.
- **Multi-business seeding is the next big *product* gap** (user flagged 2026-05-02). Currently `/seed` ignores the payload and returns canned Notion archetype shares. To be a real product: parse arbitrary CSV / X handle / brief and derive personas + audience metadata from real input.

---

## What I'd do differently next time

1. **Always smoke-test a fresh agent's tool access** as the first thing — before assigning work. Would have caught the e2e-test-runner spawn-template error in 30 seconds.
2. **Write `.team/RULES.md` BEFORE the first spawn**, not after R10. Some rules I learned the hard way; I should have anticipated them.
3. **Push more aggressively at phase boundaries.** Held some commits longer than needed, which made the GitHub history less granular than ideal for debugging.
4. **More aggressive use of Plan tool / dedicated planning agent** for cross-phase architectural decisions. I made some calls myself that would have benefited from a second opinion (e.g., the analyze-shape simplification in CONTRACTS v1).

---

End of learnings. Future team-lead: read this, then `.team/RULES.md`, then `.team/CONTRACTS.md` (current version), then `.team/STATUS.md`. That's all the institutional memory you need.
