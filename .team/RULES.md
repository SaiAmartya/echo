# .team/RULES.md — standing orders for every agent on echo-hackathon

These rules apply to **every agent** spawned into this team, including the team lead. They override default agent behavior. Read this before starting any task.

## R1 — Use up-to-date code and libraries

The user explicitly reinstated this. Before writing or recommending code that touches an external library, framework, SDK, CLI, or API:

- **Prefer Context7's `query-docs` tool** for library documentation. It pulls authoritative current docs.
- **Use `WebSearch`** for current pricing, breaking changes, deprecations, or release notes (search with the current year — May 2026).
- **Use `WebFetch`** for a specific URL the user gave you or a doc page Context7 doesn't index.
- **Do NOT rely on training-data memory** for any of: SDK call signatures, model names, pricing, env-var names, deprecation status, or framework conventions. Verify first.

When you do verify, **say so in your commit message or report-back**: e.g., "google-genai 0.8 SDK shape verified via Context7 query-docs". This lets the team trust the work without re-checking.

## R2 — Hard budget on LLM calls

Echo has a hackathon budget. Limits are LOCKED, not advisory:

- **≤1200 LLM calls per simulation.** Counter raises `BudgetExceededError` on the 1201st call. Never silent fan-out.
- **≤12 concurrent calls** via `asyncio.Semaphore(12)` (process-global).
- **Model = `gemini-2.5-flash-lite`** for per-persona / per-archetype reactions; **`gemini-3-flash-preview`** (thinking) for genesis + analysis + /report only. No additional model upgrades without team-lead approval.
- **≤256 output tokens per per-persona call** (analysis/report calls have higher caps because they emit structured JSON).

> **Note (Q1, 2026-05-02):** raised from 40 → 100 to support user-requested rounds=15 (6 archetypes × 15 + 1 analysis + 1 report = 92 calls).
>
> **Note (Z2, 2026-05-02):** raised from 100 → 1200, concurrency 6 → 12 to admit the v7 agentic engine. v7 sizing math: 50 personas × 8 rounds + 1 genesis + 1 analysis + 1 report ≈ 403 calls; 100p × 10r upper-bound ≈ 1003 calls. v6 sims still spend ~92 calls, so the raised cap is a no-op for v6 — there is **zero regression** for v6 cost. Cost at 50p × 8r ≈ $0.02/sim (most calls are Flash-Lite). Concurrency 12 keeps a single round wave at ~4-5 batches × ~2s = 8-12s.

If a phase looks like it'll cost more than its allotted estimate in `.team/STATUS.md` budget ledger, stop and message team-lead before spending.

## R3 — Don't break the locked contract

`.team/CONTRACTS.md` is **LOCKED at v1**. If you find an ambiguity or a real need to change a wire shape:

1. Stop coding.
2. `SendMessage` to `team-lead` with the proposal.
3. Wait for arbitration. **Do not silently deviate.**

This is non-negotiable because backend and frontend code in parallel against the same contract.

## R4 — Communicate via SendMessage, not by hoping

Your plain-text output is **not visible** to other agents. To communicate with a teammate or the lead, you must use the `SendMessage` tool. Address by name (`researcher`, `backend-engineer`, `frontend-engineer`, `integrator`, `e2e-tester`, `team-lead`), never by UUID.

## R5 — Idle is not done — done is done

Going idle after a turn is normal — it does not mean your task is finished. Mark a task `completed` via `TaskUpdate` only when:

- All scope items in the task description are addressed.
- For implementation tasks: code is committed AND the relevant local check passed (typecheck, smoke test, etc.).
- For research tasks: the deliverable file exists at the spec'd path.

If you can't fully complete the task, leave it `in_progress`, write what's blocking you, and message team-lead.

## R6 — Don't push without lead approval

Each engineer commits locally. **Only the team-lead pushes to GitHub.** This batches related commits and avoids partial states on `main`.

## R7 — Don't touch other agents' working trees

If you see uncommitted files in `api/` and you're the frontend-engineer, leave them alone. The lead reads working-tree state to monitor; engineers commit before passing the baton.

## R8 — Stay scoped

If you discover a refactor opportunity outside your task, write it to `docs/BACKLOG.md` (create if absent) and keep moving. Don't pull yarn threads mid-build during a hackathon.

## R10 — For browser-driven tests, spawn `general-purpose`, NOT `e2e-test-runner`

The `e2e-test-runner` subagent template in this environment is configured for a different project (TidalTasks Vitest/Playwright/Maestro) and does **not** include `mcp__claude-in-chrome__*`, `SendMessage`, or `TaskList`/`TaskUpdate`. Spawning it for echo blocks the agent immediately.

**For ANY browser automation task on echo (recording GIFs, driving the golden path, console / network audits), use:**

```
subagent_type: "general-purpose"
```

…which has all tools (`*`) including chrome MCP and the team-coordination toolset.

The agent should still call `ToolSearch` with `select:mcp__claude-in-chrome__<tool_name>` to load the chrome tool schemas before first use (they're deferred by default).

## R9 — Human QA gate at every phase boundary (NON-NEGOTIABLE)

After **every** phase completes (A, B, C, D, E, and any future phase), the team-lead **MUST**:

1. Confirm the e2e-tester (or appropriate verifier) has returned a PASS.
2. **Pause all further phase work.** Do NOT spawn the next phase's agents.
3. Hand the human a concrete, copy-pasteable QA script: the URLs to open, the exact buttons to click, and the expected visible result.
4. Keep the dev servers running for the human to test against.
5. Wait for the human's explicit "QA pass — proceed" before moving on. A missing reply is NOT a pass — it's a hold.

If the human reports any issue during QA, treat that as a Phase failure: spawn debugger or re-engage the relevant engineer with a focused fix list. Do not silently move forward.

This rule applies retroactively to **the current Phase D** and to all future phases (E and beyond).

**Why:** the e2e-tester catches functional regressions; the human catches product/UX/judgment regressions an automated test can't see. Both gates required.
