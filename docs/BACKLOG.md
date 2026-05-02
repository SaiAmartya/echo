# Echo — backlog

Items not in the basic-functionality ship. Two buckets:
- **Hackathon-late** — pick up *during* this hackathon after Phase E ships and human QA passes (the basic-functionality completion). Goal: make the swarm intelligence feel less generic before submission.
- **Post-hackathon** — out of scope for this weekend; future work.

---

## Hackathon-late (do as soon as Phase E ships and the human QA passes)

### F1 — Persona response diversity
**Source:** human QA on Phase D, 2026-05-02. "Responses should be a little bit less generic." Clarified by user 2026-05-02: this lands during the hackathon (next 1-2 hours after Phase E), not post-hackathon.

The current prompt asks Gemini for 2-4 reactions per archetype per round. Within an archetype, replies tend to converge in voice and topic. The diversity must come from prompt structure, not more LLM calls — same ≤40 calls/sim budget.

Plan (in priority order):
1. **Per-persona vibe strings.** When `personas.build_persona_pool` mints the 200 personas, tag each with a 5-10 word vibe (e.g. "ex-academic, snarky, cites stats" / "indie hacker, terse, ships things" / "pm at a megacorp, wary"). For each archetype call, sample 3 vibes from that archetype's pool and inject as "this batch of personas tends toward: ...". Forces the model to spread out tone within a cluster.
2. **Vary temperature per archetype.** Skeptics 0.85, enthusiasts 0.75, curious 0.85, practitioner 0.7, pedant 0.6, lurker 0.5. Already a `temperature` param on `_call_gemini`; just specialise it per archetype.
3. **Anti-repetition guardrail.** Pass the previous round's archetype reactions back in the user prompt as "you wrote these last round, do NOT repeat these phrasings." Adds ~40 input tokens per call (cheap on Flash-Lite, ~$0.0001 extra/sim).
4. **Sample 8 prior posts instead of 5.** Currently the prompt context shows the 5 most-recent posts. Bumping to 8, sampled with diversity (1-2 from each archetype if possible), gives the model more handles to riff against without dominating tokens.

These four together should noticeably improve perceived diversity. Suggested phase: **F1**, single backend-engineer agent, ~1 sim of testing budget.

### Streaming demo GIF for hackathon submission deck
**Blocker:** chrome MCP extension wasn't connected during Phase D verify. Browser-tester wire-verified the fix; visual GIF deferred.

When extension is connected, spawn a fresh general-purpose agent to record the golden path as a GIF for the submission deck and PR thumbnail.

## Mid-value (probably v2)

### Persistent agent memory across simulations
MiroFish uses Zep for this — same persona remembers your previous draft when you re-simulate. Out of hackathon scope.

### Persona pool from real seed material
Currently `/seed` ignores the payload and returns canned archetype shares. To honor the design's promise: parse the CSV / scrape the X handle / read the brief and *actually* derive personas from it.

### Chat with any agent post-simulation
"Click on a persona's reply → open a chat panel where you can DM that simulated agent." MiroFish offers this via ReportAgent. Echo could ship it as a Phase F.

### Real auth (Clerk or Supabase)
The AuthModal is decoration. Wire real auth so users have stable history.

## Low-value (nice-to-have)

- Mobile responsive layout
- Multi-user shared simulations
- GraphRAG over personas (out of hackathon scope per `docs/MIROFISH-NOTES.md`)
- Export simulation as a shareable URL / PDF report
