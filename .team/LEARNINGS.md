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

## L16 — Few-shot examples that match likely user inputs become parrot prompts

P6 (realism overhaul) iter-1: I supplied few-shot anchors that matched the verification scenarios (US/Canada war, calmer notifications, four-day school weeks). The numerical sentiment targets all passed but **round-1 reactions copied my example quotes verbatim**. The model used my "examples of how to think" as templates to fill in.

prompt-engineer-1 iter-2 fix: swapped to off-canon anchors (bank-CEO emissions fraud / internal onboarding redesign / city-bans-private-cars) — same `[-0.9, +0.6]` sentiment span, zero overlap with likely user input. Fixed it cleanly. The fix is now documented inline in `swarm.py` so future contributors don't undo it.

**General rule:** few-shot anchors should *demonstrate the shape* of the desired output, not *resemble* probable user inputs. If your golden test cases match your few-shot scenarios, you're not testing the model — you're testing your own examples.

## L17 — Wiping `.next/` while the dev server is running breaks routes silently

frontend-engineer-4's P1 commit landed clean (typecheck green), but when the user QA'd, `/` and `/compose` 404'd while `/history` 200'd. Cause: agent had run `rm -rf .next tsconfig.tsbuildinfo` to recover from a stale-types issue; the dev server's in-memory route manifest pointed at files that no longer existed. Routes JIT-compiled before the wipe survived; new/modified routes died.

**Fix recipe:** if any agent ever runs `rm -rf .next` for any reason, the dev server PID must be killed and restarted. `npm run typecheck` clean ≠ dev server clean. Adding to spawn template: agents must coordinate with the lead before nuking `.next` if a server is running. (Also: prefer `rm -rf .next/cache` over the whole `.next/` — narrower blast radius.)

## L19 — Deploy-env files silently override codebase defaults

Q1-BE raised `MAX_LLM_CALLS_PER_SIMULATION` default from 40 to 100 in `swarm.py`. But `api/.env` had `MAX_LLM_CALLS_PER_SIMULATION=40` hardcoded — and `.env` is gitignored, so the default raise had zero effect at runtime until backend-engineer-5 manually bumped the local `.env`. The commit only contains the codebase change.

**Rule:** when a .env-overridable default changes, either (a) bump the deployment's `.env.example` / `.env.sample` to match the new default, or (b) remove the override from local `.env` files and rely on the codebase default, or (c) call out the deploy-time bump explicitly in the commit message and any deploy runbook. Future-self deploying to a fresh machine will pull a stale `.env`, set the override back to 40, and silently reintroduce the budget regression.

## L20 — Hydrate-on-mount + persist-on-change requires a `hydrated` gate

Q1-FE caught a real bug while implementing rounds-dropdown sessionStorage persistence: in compose/page.tsx, the persist effects (`useEffect` writing to `sessionStorage`) were firing on the very first render with initial state values, BEFORE the hydrate effect's `setState` calls had taken effect. The persist effects clobbered the loaded values with the defaults. draft + mode + rounds all had this latent bug; one fix uniformly applied (a `hydrated` boolean state, gated on by all three persist effects).

**Rule:** when you have both a hydrate-on-mount effect AND persist-on-change effects targeting the same storage, gate the persist effects on a `hydrated` flag set inside the hydrate effect. Don't trust effect ordering or "the persist effect runs second so it sees the hydrated state" — React 18 may schedule them in either order under StrictMode dev double-mount.

## L21 — Animation pacing is subjective; document the knobs in the commit

Q3 (X-style thread reveal) introduced a half-dozen pacing/animation constants — `MIN_ROUND_VISIBLE_MS`, `INGEST_MIN_GAP_MS` jitter range, `LIVE_WINDOW`, per-archetype `LIKE_PROBABILITY`/`LIKE_MAX`. The user can subjectively decide they want it slower or punchier, and the next agent tuning it should NOT have to grep for "fps" or "1800" to find the dials.

frontend-engineer-7 documented the four most-likely tuning knobs with file:line in the handoff message. **That's the bar going forward** for any subjective UX phase: handoff includes the tuning-knob index, not just "feels good."

## L22 — Deterministic PRNG seeded by stable id preserves replay parity for FE-only state

Q3 needed organic-feeling like counts and probability of likes per post — but those values must be IDENTICAL between live render and replay so the user re-watching their sim sees the same heart counts. Solution: mulberry32 PRNG seeded by the post id (`p1`, `p2`, …). FE-only state, no wire shape change. Same input id → same like count + same probability roll, every time.

**Rule:** when adding FE-only animation state that must survive replay, derive it deterministically from a stable identifier already in the post payload — don't pipe new state through the SSE/replay contracts.

## L23 — Per-persona LLM agents beat archetype-batched at the same call cost-class

Z2 swapped from "6 archetype batches per round" (v6) to "50 personas × 1 call per round" (v7). Same wire contract. ~5× call count (50p×8r ≈ 400 vs v6's 92). What it bought: traceable persona→post linkage. Toronto line cook talks housing crisis, Accra pharmacist talks drug supply chains, Cape Town QA engineer talks cross-border internet — the bio shows up in the prose. v6's "200 agents" was 6 voices wearing 200 name-tags; v7 produces actual independent voices.

**Rule:** if your simulation needs personality variance to feel real, the LLM call-shape must be 1-call-per-personality, not N-personalities-per-batched-call. Token cost scales linearly; quality of variance scales superlinearly.

## L24 — LLM-generated state survives replay only if you persist the LLM's output

Z2 made `like_count` LLM-derived (each persona's call returns `likes_given: [post_ids]` — real engagement decisions, not deterministic algorithm). Replay parity then requires persisting the per-persona action payloads in `round_events.payload` so replay re-renders from disk, never re-running the LLM. Without persistence, replay = nondeterministic = useless for "watch my sim again."

**Rule:** L22 says "derive deterministically from a stable id" — that works for *FE-only* state. For LLM-generated state, the analog is "persist the LLM's output verbatim and replay from storage." Either deterministic input → output, or input → output → DB → replay.

## L25 — A loading banner is not optional UX when an LLM call gates everything

Z8 was triggered by user reporting web grounding "got stuck for 22 seconds." It was never stuck — the grounding LLM call took 17-22s before round 1 could begin streaming, with zero SSE traffic during that window. Adding `event: grounding` (status: searching/done/skipped/failed) gave the FE a banner to render. Bug went from "looks broken" to "looks like a Google search bar."

**Rule:** any time an LLM call ≥3s gates user-visible output, emit a status event the FE can bind to. Silence reads as a hang in any UX.

## L26 — Power-law engagement matters more than realistic per-post engagement

Z6 found: with 50 personas each granting up to 5 likes/round across 8 rounds, every post got 30-80 likes. Realistic per-post (each persona DID like that post organically), but UNRELALISTIC at the thread level — real social media has a runaway top + a long tail of zeros. Fix was a Zipfian post-pass transform: top 10% × 5x amplifier, bottom 50% × 0.3 dampener. After Z6: top-1 = 1700, median = 0, bottom = 0. Suddenly the thread reads like Twitter.

**Rule:** engagement realism is a DISTRIBUTION property, not a per-post property. Even if every individual like is "earned," the aggregate shape can be wrong. Apply a transform.

## L27 — Schema-name leaks need defense at parse-time, not just prompt-time

Z4 user-reported screenshot: a v7 reply rendered as `replying_to: p6\nif we're talking invasion…` — the LLM echoed a JSON schema field name into the text body. Adding "do NOT include field names in text" to the prompt is necessary but insufficient (LLMs sometimes leak even with the rule). Real fix: regex strip `(replying_to|likes_given|sentiment|action|text):value` prefixes at parse time, bounded to ~3 iterations so we don't accidentally eat real reactions starting with words like "action."

**Rule:** model-misbehavior bugs need both a prompt fix (instructive, prevents most cases) AND a parser-level sanitizer (defensive, catches the residue). Don't trust the prompt to be 100%.

## L28 — Grounding prompts must request the controversy angle, not the entity definition

Z9: "If Claude released Mythos to public" → grounding produced 71 chars of *"Claude Mythos is a frontier AI model announced by Anthropic in April 20…"* (cut mid-word). Sterile entity definition. The simulation reacted with generic "untested model" boilerplate because the load-bearing facts (Project Glasswing, zero-day exploit risk, catastrophic-risk safety thresholds) never made it into the context.

Fix: rewrite grounding system prompt with explicit "WHAT TO INCLUDE — load-bearing for a REACTION simulation (not an encyclopedia entry)" block requesting controversy/risk/stakeholder-tension angles. Bumped output from ≤450 → ~600-1000 chars and max_output_tokens from 512 → 1024. New context for the same prompt: 740 chars including Project Glasswing + zero-day + catastrophic-risk surfacing.

**Rule:** when the downstream task is "react to this," the upstream context must report what people are reacting TO. "What it is" is one short clause; "why it's controversial" is the rest.

## L29 — Auth bypass needs to mirror at every callsite, not just the provider

`NEXT_PUBLIC_DISABLE_AUTH=1` (commit 4014d15) set the AuthProvider state to a dev user — but `api.ts` imported `getCurrentIdToken` from firebase/auth.ts directly, bypassing the provider, so every API call hit 401 in bypass mode. Fix: bypass check in `authHeaders()` AND `simulateStreamUrl()`, returning the same `dev-local-token` literal AuthProvider uses. One token, three callsites, single mental model.

**Rule:** when shipping a dev-bypass, grep for every caller of the underlying function being bypassed. Bypass at the provider is necessary; bypass at the callsites is sufficient.

## L30 — Salient anchor words in system prompts get echoed verbatim

D-batch root-cause: the v7 hypothetical-mode system prompt contained *"sometimes a hypothetical scenario someone is asking the public to weigh in on"*. The LLM treated **"hypothetical scenario"** as a salient semantic anchor and echoed it back as opener templates — *"okay i'm hearing 'hypothetical question'"*, *"yo, hypothetical question, sounds like…"* — across roughly 30%+ of posts. Fix: removed the anchor word entirely; the prompt now describes input by what the persona DOES (react to substance) rather than what the input IS (a hypothetical scenario). Plus an anti-echo HARD RULE in the user prompt forbidding restated framing. After: 0 hits on "hypothetical question" / "hypothetical scenario" across 346 posts.

**Rule:** prompt language describing the input is read by the LLM as language to mirror. Describe the persona's action, not the input's category. If you must name the input type at all (e.g. "DRAFT POST" vs "SCENARIO" headers), keep it as a structural label, not embedded prose.

## L31 — Per-persona structural variation must come from prompt scaffold, not sampling noise

Same diagnosis as L30 but the second-order failure: at temp=0.95 with 50 personas sharing the same archetype-only voice prompt, openers converged because the prompt scaffold gave the LLM no orthogonal axis along which to differentiate. Bumping temperature would only have made the same opener template land in noisier flavors — incoherence, not diversity. Real fix: a closed-enum `voice_cadence` field (`direct, interrogative, clipped, narrative, wry, analytical, emotional`), deterministically sampled per persona via sha256 of persona_id, with a concrete per-cadence guide block injected into the system prompt. Each cadence steers OPENER STRUCTURE only — explicitly NOT a sentiment floor (P6 must hold under all 7).

**Rule:** if all instances of an LLM call share the same prompt scaffold and you need diverse outputs, the diversification must enter the scaffold. Sampling noise diversifies word choice, not structure. Closed enum > free-form string (no drift). Deterministic-from-id > LLM-decided (no correlation with other persona attributes). Off-canon examples > domain-specific (no verbatim collision with user prompts — D2 caught "ground-breaking. revolutionary. unprecedented." being copied 2x out of 50 because the original guide example was too memorable).

## L32 — Banned-prefix sanitizers are a safety net, not a fix

D0 added `_BANNED_OPENER_RE` mirroring `_SCHEMA_LEAK_PREFIX_RE` to strip leading echoes IF they leaked through the prompt fix. With L30+L31 in place the sanitizer fired ~0 times across the post-D2 verification sims (the prompt fix did the work). Earlier in the session there was a temptation to lead with the sanitizer (regex-strip "hypothetical question") instead of fixing the prompt — that path was explicitly rejected by user constraint *"I don't think the solution is to ban this format completely"* and would have masked the underlying issue.

**Rule:** prompt-side fixes go first; parser-side sanitizers exist only to catch leak-through. If the sanitizer fires often (target ≤1% of outputs), the prompt is still leaking and the regex is hiding it. Diagnostic counter on the sanitizer is the canary — wire it from day one.

---

## L18 — The pivot model: additive contracts, mode-aware prompts, default to the new front door

Pivoting from "social-post pre-flight for marketing" to "what will people think if..." worked because we:
1. **Locked v4 contract additively** (mode field with `default = "business"` for backward-compat). Old FE keeps working without modification. New FE drives the new flow. No migration coordination needed.
2. **Mode-aware prompts, not separate engines.** Same archetype loop, same budget caps, same SSE shape — only the user-prompt header (`DRAFT POST` → `SCENARIO`) and audience_blurb differ. P6 added calibration on top, but the engine never moved.
3. **Made the new mode the default.** "Hypothetical situation" defaults the dropdown; `/` redirects to `/compose`. The old flow is reachable but not promoted. This is the L13 lesson applied at the *application* level: if the pivot's framing is the killer-flow, make the killer-flow the default.

Cost: ~140 LLM calls across all 4 phases (P1 0, P2 ~20, P3 ~20, P6 ~120 with two iterations). One Sunday afternoon of agent-driven execution. The most expensive single decision was **iter-1 of P6** burning ~60 calls before the mimicry catch — a verification-loop-level cost, not a wasted-effort cost.

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
