# Echo — post-hackathon backlog

Items that are out of scope for the hackathon ship but worth picking up next.

## High-value enhancements (do first when we resume)

### Persona response diversity
**Source:** human QA on Phase D, 2026-05-02. "Responses should be a little bit less generic."

The current prompt asks Gemini for 2-4 reactions per archetype per round. Within an archetype, replies tend to converge in voice and topic. To improve:

- **Add per-persona "vibe" strings** when generating the 200-persona pool (e.g. "ex-academic, snarky, cites stats" / "indie hacker, terse, ships things"). Inject 2-3 vibes per archetype prompt as "this batch tends toward X / Y / Z."
- **Include the previous round's posts** more aggressively in the prompt — currently we send top-5; sending top-8-12 with diverse-by-archetype sampling gives the model more to riff against.
- **Vary temperature per archetype** — skeptics at 0.85, enthusiasts at 0.7, lurkers at 0.5 (keeps lurkers terse, lets skeptics meander).
- **Anti-repetition guardrail** — track the last 50 reactions; ask the model to "avoid repeating these phrasings" if it starts to converge. Adds cost (more input tokens) but cheap on Flash-Lite.

Note: this is bound by the same ≤40 calls/sim budget. The diversity comes from prompt structure, not more calls.

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
