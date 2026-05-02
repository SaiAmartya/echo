# MiroFish — pattern inventory & Echo mapping

Source: https://github.com/666ghj/MiroFish (58k★, "A Simple and Universal Swarm Intelligence Engine, Predicting Anything"). The user named MiroFish as the spiritual ancestor of Echo's swarm intelligence.

This doc catalogs MiroFish's patterns and maps each one to Echo's hackathon scope: **already have**, **bank for Phase E**, or **out of scope (post-hackathon)**.

## MiroFish pillars (from their README)

1. **Graph building** — seed extraction → individual/collective memory injection → GraphRAG persona network
2. **Environment setup** — entity relationship extraction → persona generation → agent configuration injection
3. **Simulation** — dual-platform parallel simulation → auto-parse prediction requirements → dynamic temporal memory updates
4. **Report generation** — ReportAgent with rich toolset for deep post-sim interaction
5. **Deep interaction** — chat with any agent in the simulated world; interact with ReportAgent
6. **Stack** — Python (uv) backend, Vue frontend, Node 18+, OpenAI-SDK-compatible LLM (Qwen-plus default), Zep Cloud for memory, **CAMEL-AI/OASIS as the simulation engine** under the hood.

## Mapping to Echo's locked v1 design

| MiroFish pattern | Echo v1 status | Notes |
|---|---|---|
| Seed → audience derivation | ✅ have it (POST /seed accepts csv/oauth/sample) | v1 returns canned archetype shares; Phase E can wire real CSV parsing without breaking the contract. |
| Persona generation | ✅ have it (`api/app/personas.py`, 200 personas) | Lighter than MiroFish — name+handle+archetype+audience only, no biography/preferences. **Bank for Phase E:** add 1-line persona "vibe" string per agent so prompts can vary inside a cluster. |
| Multi-round social evolution | ✅ have it (5 rounds × 6 archetype calls, agents reply to each other via `parent` post id) | This is the core of CONTRACTS.md §3 — already locked. |
| Dual-platform simulation (target audience vs public) | ✅ have it (`agent.audience: "target"|"public"` on every post) | Already in the wire format. The SwarmThread visualization renders this distinction (target audience gets a ringed dot in the swarm map). |
| Dogpile / cluster dynamics | ✅ have it (≥2 children on a post triggers "dogpile" halo in SwarmThread; researcher's prompt explicitly invites the model to "dogpile" the most-recent reply) | This is the visceral demo moment. |
| ReportAgent (final aggregate analysis) | ✅ have it (single Gemini call → `tldr` + `suggested_rewrite` + `worth_reading[3]`) | MiroFish's ReportAgent uses tool-use for deep aggregation; ours is one-shot at hackathon scale. **Bank for Phase E:** add a 2nd analysis call for sentiment-trend extraction if budget allows. |
| Long-term agent memory (Zep) | ⏸ out of scope for v1 | Within a single 5-round sim, our "include top-5 prior posts in the prompt" is short-term memory. Cross-sim memory (persona X remembers your last draft) is post-hackathon. |
| GraphRAG persona network | ⏸ out of scope for v1 | The `parent` post-id chain *is* a runtime relationship graph; we just don't build a full RAG over it. The SwarmMap viz already shows the edges. |
| Deep interaction (chat with any agent post-sim) | ⏸ out of scope for v1 | Could wire an `/agents/:id/chat` endpoint after the hackathon — would be a great showcase feature. **Bank for post-hackathon roadmap.** |
| Auto-parse prediction requirements | ⏸ out of scope for v1 | Echo's "prediction" is fixed: how will this post land? MiroFish parses arbitrary prediction asks. |
| OASIS engine | ⏸ out of scope for v1 | Adopting CAMEL-AI/OASIS now would invalidate our locked CONTRACTS.md and SWARM-DESIGN.md. The 31-call/sim budget bound is incompatible with OASIS's fan-out. **Note for v2 if Echo grows past hackathon.** |

## Tactical Phase-E enhancements inspired by MiroFish

These are safe additions that don't touch the locked contract:

1. **Per-persona vibe string.** When generating the 200 personas, tag each with a 5-10 word vibe. Inject into the archetype prompt as "this batch of personas tends toward X" to vary tone within a cluster. Adds 0 LLM calls.
2. **Round-N "shift" annotation.** Track sentiment delta per round on the backend; surface in the analysis as "by round 3, the room shifted from skeptical to mixed." Free, derived from existing data.
3. **"Pretend you're MiroFish" framing in the system prompt.** The researcher's prompt is already strong; adding a single line — "you are simulating a public's organic Twitter reaction" — has been shown in MiroFish to reduce LLM hedging. Already partially in our prompt; verify in Phase E.
4. **Highlight the most-replied-to post.** In `worth_reading`, prefer the post with the biggest sub-thread. Already implicitly done; make it explicit.

## Out-of-scope for this hackathon (record as future work)

- GraphRAG over personas
- Zep / persistent persona memory across sessions
- Interactive chat with any agent after the sim
- Multi-prediction parsing (Echo is single-purpose: pre-flight a draft post)

## Risk: do NOT do these mid-build

- **Do not switch to OASIS.** It would invalidate the locked design and budget.
- **Do not add Zep.** New SDK, new key, new contract, no time.
- **Do not bolt GraphRAG on top.** Our `parent` chain is sufficient for the demo.

## Source

- MiroFish: https://github.com/666ghj/MiroFish
- Their underlying simulation engine: https://github.com/camel-ai/oasis
- MiroFish README pulled 2026-05-02
