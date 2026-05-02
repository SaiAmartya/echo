# Echo Team — Live Status

Updated by each agent after every meaningful task. One line per agent.

| Agent | Status | Last update | Current task |
|---|---|---|---|
| lead (claude-opus-4-7) | 🟢 active | 2026-05-01 21:35 | Phase A spawned; awaiting researcher |
| researcher (opus) | 🟡 working | 2026-05-01 21:35 | Phase A — SWARM-DESIGN.md + CONTRACTS.md |
| backend-engineer | ⚪ pending | — | — |
| frontend-engineer | ⚪ pending | — | — |
| integrator | ⚪ pending | — | — |
| e2e-tester | ⚪ pending | — | — |
| debugger | 💤 standby | — | spawned on demand |

## Phase tracker

- [ ] **A** — Swarm engine research (`docs/SWARM-DESIGN.md`)
- [ ] **B** — Real Gemini-backed backend
- [ ] **C** — Frontend wired to real backend
- [ ] **D** — Integration + E2E green
- [ ] **E** — Demo polish + GIF + handoff

## Budget ledger

| Phase | LLM calls (estimated) | LLM calls (actual) |
|---|---|---|
| A (research) | 0 | — |
| B (backend dev) | ~5 (smoke tests only) | — |
| C (frontend dev) | 0 | — |
| D (E2E full simulation) | ≤40 per run × 3 runs = 120 | — |
| E (polish) | ≤40 × 2 runs = 80 | — |
| **Hackathon ceiling** | **≤300 total** | — |
