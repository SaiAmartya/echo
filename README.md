# Echo

Pre-flight check for social posts: a swarm of 200 simulated personas reacts (and reacts to each other) before you publish.

This repo currently contains **Step 1 (Skeleton)** of `ACTION-PLAN.md` — Next.js + Tailwind frontend, FastAPI + SQLite backend with stub endpoints, and the design ported from the `Echo Prototype.html` bundle into real React pages. All four backend endpoints (`/seed`, `/simulate/start`, `/simulate/stream`, `/analyze`) return canned data so the end-to-end happy path is verifiable on localhost. Real LLM calls land in Step 2

```
echo/
├── ACTION-PLAN.md
├── design/echo/...        # original Claude Design bundle (HTML/JSX prototype, kept for reference)
├── web/                   # Next.js 14 (App Router, TS, Tailwind)
└── api/                   # FastAPI 0.13x + SQLite
```

## Run it locally

You'll need two terminals — one for the backend, one for the frontend.

### Terminal 1 — backend (FastAPI on :8000)

```bash
cd api
./run.sh        # creates .venv on first run, installs deps, starts uvicorn --reload
```

The first run takes ~30s to install deps. Subsequent runs start instantly. Health check: open http://127.0.0.1:8000/health, you should see `{"status":"ok","version":"0.1.0"}`.

### Terminal 2 — frontend (Next.js on :3000)

```bash
cd web
cp .env.local.example .env.local        # only needed once
npm run dev
```

Open http://localhost:3000.

The frontend's `next.config.mjs` proxies `/api/*` → `NEXT_PUBLIC_API_BASE` (defaults to `http://127.0.0.1:8000`), so you don't need to think about CORS during dev.

## Step 1 happy path

1. Land on `/` (Landing).
2. Click **Start with your audience** → `/audience`. Click **Use this audience** (or **Skip · use sample audience** in the top right). Backend's `POST /seed` returns a canned Notion-style audience profile.
3. You're routed to `/compose`. The sample draft is pre-loaded if you came in via "Try a sample". Hit **Run simulation**. Backend's `POST /simulate/start` returns a fresh `simulation_id`.
4. `/simulating?id=…` opens an `EventSource` against `GET /simulate/stream`. Five canned `round` events arrive ~1s apart. The SwarmThread visualization advances round-by-round. After the final round a `done` event redirects to `/results?id=…`.
5. `/results` calls `GET /analyze` and renders the canned ratio-risk score, sentiment distribution, predicted top replies, rewrite suggestion, and risk flags.

That's the Step 1 benchmark from `ACTION-PLAN.md` — clicking "Use this audience" navigates to compose, clicking "Run" hits a stub backend that returns canned data, end-to-end works on localhost.

## Auth (Step 1 status)

The AuthModal from the design bundle is ported and wired to the landing page **Sign in** button — so the modal opens, accepts input, and closes. It does **not** authenticate against any provider yet.

To swap in Clerk later (Step 1 of `ACTION-PLAN.md` mentions Clerk *or* Supabase Auth):

1. `cd web && npm install @clerk/nextjs`
2. Sign up at https://dashboard.clerk.com/, create an application, copy the publishable + secret keys into `web/.env.local` (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`).
3. Wrap `src/app/layout.tsx` body with `<ClerkProvider>{children}</ClerkProvider>`.
4. Replace the body of `src/components/AuthModal.tsx` with `<SignIn />` from `@clerk/nextjs`.

Holding off on the install means Step 1 can be tested without anyone having to register for a Clerk account.

## What lives where

| Path | Purpose |
|---|---|
| `web/src/app/page.tsx` | `Landing` — hero, ambient SVG ripple, sign-in modal trigger |
| `web/src/app/audience/page.tsx` | `Audience` — CSV-paste / X-OAuth tabs, calls `POST /seed` |
| `web/src/app/compose/page.tsx` | `Compose` — draft + run controls, calls `POST /simulate/start` |
| `web/src/app/simulating/page.tsx` | `Simulating` — live SwarmThread driven by the SSE stream |
| `web/src/app/results/page.tsx` | `Results` — calls `GET /analyze`, renders ratio risk + replies + rewrite |
| `web/src/app/history/page.tsx` | `History` — static list backed by `web/src/lib/data.ts` |
| `web/src/components/SwarmThread.tsx` | The "agents react to each other" viz (left thread + right swarm map) |
| `web/src/components/AmbientViz.tsx` | The slow lime ripple loop on the landing hero |
| `web/src/components/AuthModal.tsx` | Sign-in modal (presentation only — see Auth section above) |
| `api/app/main.py` | FastAPI entrypoint, four stub endpoints, SSE round emitter |
| `api/app/db.py` | SQLite helpers (`audiences`, `simulations`, `round_events`, `analyses`) |
| `api/app/canned.py` | The hard-coded responses Step 1 returns |

## What's intentionally *not* in Step 1

Per `ACTION-PLAN.md`:

- No real LLM calls (Step 2 swaps `simulate_stream` and `analyze` to real Gemini Flash-Lite + Sonnet calls).
- No real X API (CSV-paste only is acceptable demo theater).
- No graph DB, no vector DB, no cross-session persona memory.
- No mobile responsiveness — desktop-first per the design.
