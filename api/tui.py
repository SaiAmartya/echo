"""Echo TUI — terminal control plane as an HTTP client over the existing API.

This is an *alternate interface* to the GUI. It is a pure HTTP client over the
running uvicorn server (POST /simulate/start → SSE /simulate/stream →
POST /report). It imports nothing from `api.app.swarm` or `api.engine.*` — the
TUI works against the locked wire contract (CONTRACTS.md v1..v7) and is
intentionally agnostic to which engine version is running on the backend.

Three screens, in order:

    ComposeScreen   — pick mode + rounds + persona_count + web_grounding,
                      type a draft, press Run
    SimulateScreen  — live SSE thread (left) + room archetype tallies (right)
    ReportScreen    — executive summary + verdict + audience reception cards
                      + risk vectors + rewrite options + comparable discourse

Global keys:
    q       quit
    n       new simulation (back to compose)
    ?       help (toast)
    ctrl+c  hard quit

Run:
    # backend must be up at $ECHO_API_BASE (default http://127.0.0.1:8000)
    python -m api.tui

Auth (hackathon scope): every request sends
    Authorization: Bearer dev-local-token
…and SSE adds ?token=dev-local-token (the sse-starlette stream takes a query
param because EventSource can't attach Authorization headers — see auth.py
`current_user_uid_from_query`). The api accepts any token string when
FIREBASE_AUTH_DISABLED=1 is set on the server side.

Visual design adapted from PR #1 (closed without merge — bundled a parallel
engine rewrite that would have regressed v7).

Verified before writing (R1):
    * Textual 8.x widget API (App / Screen / Binding / @on / reactive /
      Static.update with Rich markup) via Context7 textualize/textual.
    * httpx 0.28 async streaming SSE pattern via aiter_lines() — preserved
      blank-line frame boundaries by tracking event_name across data lines.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Optional

try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]

    load_dotenv(Path(__file__).parent / ".env")
except Exception:  # pragma: no cover — dotenv is optional
    pass

import httpx
from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.screen import Screen
from textual.widgets import (
    Button,
    Checkbox,
    Footer,
    Header,
    Label,
    Select,
    Static,
    TextArea,
)


# ----------------------------------------------------------------- config

API_BASE = os.environ.get("ECHO_API_BASE", "http://127.0.0.1:8000").rstrip("/")
DEV_TOKEN = os.environ.get("ECHO_TUI_DEV_TOKEN", "dev-local-token")
AUTH_HEADERS = {"Authorization": f"Bearer {DEV_TOKEN}"}

# Round counts allowed by CONTRACTS v5 §20.
ROUND_OPTIONS = [(str(n), n) for n in (5, 6, 8, 10, 12, 15)]
# v7 §27 allows [30, 100]. Fixed dropdown options keep the UX tight. The
# DEV-mode 17-persona pool is selected by the server when ECHO_DEV_MODE=1
# regardless of what the client sends, so we don't expose a 17 option here
# (the wire validator would reject persona_count<30 with HTTP 422).
PERSONA_OPTIONS = [
    ("30", 30),
    ("50 (default)", 50),
    ("75", 75),
    ("100", 100),
]
MODE_OPTIONS = [
    ("Hypothetical situation", "hypothetical"),
    ("Business · Notion sample", "business"),
]

# Archetype glyphs + Rich color styles. Order matches CONTRACTS v1 §3.
ARCHETYPES = ["enthusiast", "practitioner", "curious", "lurker", "pedant", "skeptic"]
ARCH_GLYPH = {
    "enthusiast": "★",
    "practitioner": "◆",
    "curious": "?",
    "lurker": "·",
    "pedant": "※",
    "skeptic": "✗",
}
ARCH_STYLE = {
    "enthusiast": "bold green",
    "practitioner": "bold blue",
    "curious": "bold cyan",
    "lurker": "dim white",
    "pedant": "bold magenta",
    "skeptic": "bold red",
}
VERDICT_STYLE = {
    "ship": "bold black on green",
    "revise": "bold black on yellow",
    "rethink": "bold white on red",
}
SEVERITY_STYLE = {
    "low": "green",
    "medium": "yellow",
    "high": "bold red",
}
TONE_STYLE = {
    "positive": "green",
    "caution": "yellow",
    "danger": "bold red",
    "neutral": "dim",
}


def sentiment_style(s: float) -> str:
    if s >= 0.3:
        return "green"
    if s <= -0.3:
        return "red"
    return "yellow"


def _markup_escape(text: str) -> str:
    """Escape `[` so user-supplied content can't open Rich markup tags.

    Rich/Textual content rendering walks markup tokens; an unbalanced `[i`
    in a draft would mangle the rest of the line. Escape both forms used by
    Rich's parser. We don't escape `]` because a stray closer is a no-op.
    """
    return text.replace("[", r"\[")


# ----------------------------------------------------------------- HTTP client


class EchoClient:
    """Tiny wrapper around httpx for the four endpoints the TUI uses.

    Async; one shared `httpx.AsyncClient` per app run (created lazily so the
    Textual event loop owns the connection pool). All non-SSE calls send the
    bearer header; the SSE stream call adds `?token=` because EventSource
    semantics constrain the api to accept SSE auth via query string.
    """

    def __init__(self, base: str = API_BASE, token: str = DEV_TOKEN) -> None:
        self.base = base
        self.token = token
        self._client: Optional[httpx.AsyncClient] = None

    async def _get(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def health(self) -> dict:
        c = await self._get()
        r = await c.get(f"{self.base}/health")
        r.raise_for_status()
        return r.json()

    async def seed_sample(self) -> dict:
        c = await self._get()
        r = await c.post(
            f"{self.base}/seed",
            json={"mode": "sample", "payload": None},
            headers=AUTH_HEADERS,
        )
        r.raise_for_status()
        return r.json()

    async def simulate_start(
        self,
        *,
        draft: str,
        mode: str,
        rounds: int,
        audience_id: Optional[str],
        persona_count: Optional[int],
        web_grounding: bool,
    ) -> dict:
        body: dict[str, Any] = {
            "draft": draft,
            "mode": mode,
            "rounds": rounds,
            "web_grounding": web_grounding,
        }
        if audience_id is not None:
            body["audience_id"] = audience_id
        if persona_count is not None:
            body["persona_count"] = persona_count
        c = await self._get()
        r = await c.post(
            f"{self.base}/simulate/start", json=body, headers=AUTH_HEADERS
        )
        r.raise_for_status()
        return r.json()

    async def stream(self, simulation_id: str):
        """Async generator yielding (event_name, data_dict) per SSE frame.

        SSE frames are separated by blank lines. Within a frame, `event:`
        sets the name and `data:` carries JSON. We track event_name across
        data lines and reset on blank-line frame boundaries so consecutive
        `round` events don't bleed into each other when /aiter_lines collapses
        whitespace differently across chunked transfers.
        """
        url = f"{self.base}/simulate/stream"
        params = {"simulation_id": simulation_id, "token": self.token}
        c = await self._get()
        async with c.stream(
            "GET", url, params=params, headers=AUTH_HEADERS, timeout=None
        ) as resp:
            if resp.status_code != 200:
                raw = await resp.aread()
                raise httpx.HTTPStatusError(
                    f"SSE {resp.status_code}: {raw.decode(errors='replace')[:200]}",
                    request=resp.request,
                    response=resp,
                )
            event_name = "message"
            async for raw in resp.aiter_lines():
                if not raw:
                    # Frame boundary — reset to default for the next frame.
                    event_name = "message"
                    continue
                if raw.startswith(":"):
                    # SSE comment (sse-starlette uses these as keep-alives).
                    continue
                if raw.startswith("event:"):
                    event_name = raw.split(":", 1)[1].strip()
                elif raw.startswith("data:"):
                    payload = raw.split(":", 1)[1].strip()
                    if not payload:
                        continue
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    yield event_name, data

    async def report(self, simulation_id: str) -> dict:
        c = await self._get()
        r = await c.post(
            f"{self.base}/report",
            params={"simulation_id": simulation_id},
            headers=AUTH_HEADERS,
            timeout=httpx.Timeout(60.0, read=120.0),
        )
        r.raise_for_status()
        return r.json()


# ----------------------------------------------------------------- Compose screen


class ComposeScreen(Screen):
    BINDINGS = [
        Binding("ctrl+r", "run", "Run"),
        Binding("q", "app.quit", "Quit"),
        Binding("?", "help", "Help"),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="compose-root"):
            yield Static("[b]Echo · what will people think if…[/b]", id="compose-title")
            yield Static(
                f"[dim]API: {API_BASE}  ·  auth: dev-local-token "
                f"(requires FIREBASE_AUTH_DISABLED=1 on api side)[/dim]",
                id="compose-meta",
            )

            with Horizontal(classes="row"):
                yield Label("Mode:", classes="row-label")
                yield Select(
                    MODE_OPTIONS, value="hypothetical", id="mode", allow_blank=False
                )
                yield Label("Rounds:", classes="row-label")
                yield Select(
                    ROUND_OPTIONS, value=5, id="rounds", allow_blank=False
                )
                yield Label("Personas:", classes="row-label")
                yield Select(
                    PERSONA_OPTIONS, value=50, id="persona_count", allow_blank=False
                )

            with Horizontal(classes="row"):
                yield Checkbox(
                    "Web grounding (anchor reactions to recent real-world facts)",
                    value=False,
                    id="web_grounding",
                )

            yield Label("Draft (max 3500 chars):", classes="draft-label")
            yield TextArea("", id="draft", language="markdown")
            yield Static("[dim]0 / 3500[/dim]", id="char-count")

            with Horizontal(id="compose-actions"):
                yield Button("Run simulation", variant="primary", id="run-btn")
                yield Static("", id="compose-error")

        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#draft", TextArea).focus()

    @on(TextArea.Changed, "#draft")
    def _on_draft_changed(self, event: TextArea.Changed) -> None:
        text = event.text_area.text
        n = len(text)
        style = "red" if n > 3500 else ("yellow" if n > 3000 else "dim")
        self.query_one("#char-count", Static).update(f"[{style}]{n} / 3500[/]")

    @on(Button.Pressed, "#run-btn")
    def _on_run_button(self) -> None:
        self.action_run()

    def action_run(self) -> None:
        draft = self.query_one("#draft", TextArea).text.strip()
        rounds_val = self.query_one("#rounds", Select).value
        mode_val = self.query_one("#mode", Select).value
        pc_val = self.query_one("#persona_count", Select).value
        wg_val = self.query_one("#web_grounding", Checkbox).value
        err = self.query_one("#compose-error", Static)

        if not draft:
            err.update("[red]draft is empty[/red]")
            return
        if len(draft) > 3500:
            err.update(f"[red]draft is {len(draft)} chars (max 3500)[/red]")
            return
        if not isinstance(rounds_val, int) or not isinstance(pc_val, int):
            err.update("[red]pick rounds and persona count[/red]")
            return
        if mode_val not in ("hypothetical", "business"):
            err.update("[red]pick a mode[/red]")
            return

        err.update("")
        self.app.push_screen(
            SimulateScreen(
                draft=draft,
                mode=str(mode_val),
                rounds=int(rounds_val),
                persona_count=int(pc_val),
                web_grounding=bool(wg_val),
            )
        )

    def action_help(self) -> None:
        self.notify(
            "Compose: pick mode + rounds + persona count, type a draft, "
            "Ctrl+R or click Run. Hypothetical mode skips audience seeding.",
            severity="information",
            timeout=6,
        )


# ----------------------------------------------------------------- Thread + Room widgets


class ThreadFeed(VerticalScroll):
    """Append-only post list. We diff incoming cumulative posts vs seen ids."""

    def append_post(self, p: dict) -> None:
        agent = p.get("agent") or {}
        archetype = str(agent.get("archetype") or "lurker")
        glyph = ARCH_GLYPH.get(archetype, "·")
        ar_style = ARCH_STYLE.get(archetype, "white")
        sentiment = float(p.get("sentiment", 0.0))
        sent_mark = f"[{sentiment_style(sentiment)}]{sentiment:+.2f}[/]"
        handle = _markup_escape(str(agent.get("handle") or "@unknown"))
        text = _markup_escape(str(p.get("text") or ""))
        post_id = str(p.get("id") or "?")
        round_num = int(p.get("round") or 0)
        like_count = int(p.get("like_count") or 0)
        reply_count = int(p.get("reply_count") or 0)
        parent = str(p.get("parent") or "")

        engagement_bits = []
        if like_count:
            engagement_bits.append(f"♥ {like_count}")
        if reply_count:
            engagement_bits.append(f"↩ {reply_count}")
        engagement = (
            f"  [dim]{' · '.join(engagement_bits)}[/dim]" if engagement_bits else ""
        )

        reply_to = (
            f"  [dim]↳ {parent}[/dim]" if parent and parent != "seed" else ""
        )

        block = (
            f"[{ar_style}]{glyph} {archetype:<12}[/]  "
            f"[bold]{handle}[/]  {sent_mark}  "
            f"[dim]r{round_num} · {post_id}[/dim]"
            f"{reply_to}{engagement}\n"
            f"  {text}"
        )
        self.mount(Static(block, classes="reply-card"))
        self.scroll_end(animate=False)

    def add_round_marker(self, n: int, of: int) -> None:
        bar = "─" * 6
        self.mount(
            Static(
                f"\n[bold]{bar} round {n} of {of} {bar}[/bold]\n",
                classes="round-bar",
            )
        )
        self.scroll_end(animate=False)


class RoomPanel(Static):
    """Right panel — running archetype + sentiment summary."""

    counts: reactive[dict] = reactive(dict)
    sentiments: reactive[list] = reactive(list)
    round_num: reactive[int] = reactive(0)
    of_rounds: reactive[int] = reactive(0)
    total: reactive[int] = reactive(0)
    target_count: reactive[int] = reactive(0)
    web_grounding: reactive[bool] = reactive(False)

    def render(self) -> str:
        lines = ["[b]The room[/b]\n"]
        lines.append(f"[dim]round[/dim]    {self.round_num} of {self.of_rounds}")
        lines.append(f"[dim]replies[/dim]  {self.total}")
        lines.append(
            f"[dim]target[/dim]   {self.target_count}  "
            f"[dim]public[/dim] {self.total - self.target_count}"
        )
        if self.sentiments:
            avg = sum(self.sentiments) / len(self.sentiments)
            lines.append(
                f"[dim]mean[/dim]     [{sentiment_style(avg)}]{avg:+.2f}[/]"
            )
        if self.web_grounding:
            lines.append("[bold green]● web grounding ON[/]")
        lines.append("")
        lines.append("[b]archetypes[/b]")
        max_count = max(self.counts.values()) if self.counts else 1
        for arc in ARCHETYPES:
            n = int(self.counts.get(arc, 0))
            bar_len = int(18 * n / max_count) if max_count else 0
            bar = "█" * bar_len
            style = ARCH_STYLE[arc]
            lines.append(
                f"  [{style}]{ARCH_GLYPH[arc]} {arc:<12}[/] "
                f"[{style}]{bar}[/] [dim]{n}[/dim]"
            )
        return "\n".join(lines)


# ----------------------------------------------------------------- Simulate screen


class SimulateScreen(Screen):
    BINDINGS = [
        Binding("n", "back", "New"),
        Binding("q", "app.quit", "Quit"),
        Binding("?", "help", "Help"),
    ]

    def __init__(
        self,
        *,
        draft: str,
        mode: str,
        rounds: int,
        persona_count: int,
        web_grounding: bool,
    ) -> None:
        super().__init__()
        self.draft = draft
        self.mode = mode
        self.rounds = rounds
        self.persona_count = persona_count
        self.web_grounding = web_grounding
        self.simulation_id: Optional[str] = None
        self.seen_post_ids: set[str] = set()
        self._task: Optional[asyncio.Task] = None
        self._cancelled = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="sim-root"):
            yield Static(
                f"[b]post:[/b] [dim]{_markup_escape(self.draft[:200])}"
                f"{'…' if len(self.draft) > 200 else ''}[/dim]",
                id="sim-post",
            )
            yield Static(
                f"[b]Round 0 of {self.rounds}[/]  ·  0 replies  ·  "
                f"mode={self.mode}  ·  personas={self.persona_count}"
                f"{'  ·  [bold green]web grounding ON[/]' if self.web_grounding else ''}",
                id="sim-topbar",
            )
            with Horizontal(id="sim-cols"):
                yield ThreadFeed(id="thread")
                yield RoomPanel(id="room")
            yield Static("[dim]starting…[/dim]", id="sim-status")
        yield Footer()

    def on_mount(self) -> None:
        room = self.query_one(RoomPanel)
        room.web_grounding = self.web_grounding
        room.of_rounds = self.rounds
        self._task = asyncio.create_task(self._drive())

    async def _drive(self) -> None:
        client: EchoClient = self.app.client  # type: ignore[attr-defined]
        thread = self.query_one(ThreadFeed)
        room = self.query_one(RoomPanel)
        status = self.query_one("#sim-status", Static)
        topbar = self.query_one("#sim-topbar", Static)

        counts: Counter = Counter()
        sentiments: list[float] = []
        target_count = 0
        last_round = 0

        # ---- Step 1: optional /seed for business mode (Notion sample) ----
        audience_id: Optional[str] = None
        if self.mode == "business":
            status.update("[dim]seeding sample audience…[/dim]")
            try:
                seed = await client.seed_sample()
                audience_id = seed.get("audience_id")
            except Exception as e:
                status.update(f"[red]seed failed: {self._fmt_err(e)}[/red]")
                return

        # ---- Step 2: POST /simulate/start ----
        status.update("[dim]registering simulation…[/dim]")
        try:
            start = await client.simulate_start(
                draft=self.draft,
                mode=self.mode,
                rounds=self.rounds,
                audience_id=audience_id,
                persona_count=self.persona_count,
                web_grounding=self.web_grounding,
            )
        except Exception as e:
            status.update(f"[red]start failed: {self._fmt_err(e)}[/red]")
            return
        self.simulation_id = start.get("simulation_id")
        if not self.simulation_id:
            status.update("[red]no simulation_id in /simulate/start response[/red]")
            return
        status.update(f"[dim]streaming · {self.simulation_id}[/dim]")

        # ---- Step 3: SSE stream ----
        try:
            async for event_name, data in client.stream(self.simulation_id):
                if self._cancelled:
                    return
                if event_name == "round":
                    n = int(data.get("round") or 0)
                    of = int(data.get("of") or self.rounds)
                    posts = data.get("posts") or []
                    if n != last_round:
                        thread.add_round_marker(n, of)
                        last_round = n
                    new_posts = [
                        p
                        for p in posts
                        if str(p.get("id") or "") not in self.seen_post_ids
                    ]
                    # Posts are sorted (round asc, id asc) per CONTRACTS §3,
                    # so iterating in payload order yields a coherent thread.
                    for p in new_posts:
                        pid = str(p.get("id") or "")
                        if not pid:
                            continue
                        self.seen_post_ids.add(pid)
                        thread.append_post(p)
                        agent = p.get("agent") or {}
                        arc = str(agent.get("archetype") or "lurker")
                        counts[arc] += 1
                        sentiments.append(float(p.get("sentiment", 0.0)))
                        if str(agent.get("audience") or "") == "target":
                            target_count += 1
                    # We trust the cumulative payload's likes/replies for the
                    # already-rendered cards by reading `posts` here too — but
                    # we don't re-render; the latest values arrive on the
                    # next frame as the post line refreshes (cheap enough at
                    # ≤200 cards). If a like-count mid-stream bump becomes
                    # visually critical we'd swap append_post for a
                    # keyed-replace; out of scope for v1 of the TUI.
                    room.counts = dict(counts)
                    room.sentiments = list(sentiments)
                    room.total = len(self.seen_post_ids)
                    room.target_count = target_count
                    room.round_num = n
                    room.of_rounds = of
                    topbar.update(
                        f"[b]Round {n} of {of}[/]  ·  {len(self.seen_post_ids)} replies  ·  "
                        f"mode={self.mode}  ·  personas={self.persona_count}"
                        f"{'  ·  [bold green]web grounding ON[/]' if self.web_grounding else ''}"
                    )
                elif event_name == "done":
                    status.update("[dim]rounds complete · generating report…[/dim]")
                    break
                elif event_name == "error":
                    msg = data.get("message", "stream error")
                    code = data.get("code", "unknown")
                    status.update(
                        f"[red]engine error: {_markup_escape(str(msg))} "
                        f"[dim]({code})[/dim][/red]"
                    )
                    return
        except Exception as e:
            status.update(f"[red]stream error: {self._fmt_err(e)}[/red]")
            return

        if self._cancelled:
            return

        # ---- Step 4: POST /report ----
        try:
            report = await client.report(self.simulation_id)
        except Exception as e:
            status.update(f"[red]/report failed: {self._fmt_err(e)}[/red]")
            return
        if self._cancelled:
            return
        status.update("[green]done · pushing report[/green]")
        self.app.push_screen(ReportScreen(report=report, draft=self.draft))

    def _fmt_err(self, e: Exception) -> str:
        if isinstance(e, httpx.HTTPStatusError):
            try:
                body = e.response.json()
                detail = body.get("detail")
                if isinstance(detail, dict):
                    return _markup_escape(
                        f"{detail.get('detail', '?')} ({detail.get('code', '?')})"
                    )
                return _markup_escape(str(detail or body))
            except Exception:
                return _markup_escape(f"HTTP {e.response.status_code}")
        return _markup_escape(f"{type(e).__name__}: {e}")

    def action_back(self) -> None:
        self._cancelled = True
        if self._task and not self._task.done():
            self._task.cancel()
        # Pop the simulate screen → back to compose.
        self.app.pop_screen()

    def action_help(self) -> None:
        self.notify(
            "Simulate: posts stream as the engine completes each round. "
            "Press n to abandon and return to compose.",
            severity="information",
            timeout=6,
        )


# ----------------------------------------------------------------- Report screen


class ReportScreen(Screen):
    BINDINGS = [
        Binding("n", "new", "New sim"),
        Binding("q", "app.quit", "Quit"),
        Binding("?", "help", "Help"),
    ]

    def __init__(self, *, report: dict, draft: str) -> None:
        super().__init__()
        self.report = report
        self.draft = draft

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="report-root"):
            r = self.report or {}
            body = r.get("report") or {}
            verdict = str(body.get("verdict") or "revise").lower()
            verdict_style = VERDICT_STYLE.get(verdict, "bold white on grey50")
            mode = str(r.get("mode") or "hypothetical")
            audience_label = str(r.get("audience_label") or "")
            generated_at = str(r.get("generated_at") or "")
            model = str(r.get("model") or "")

            yield Static("[b]Echo · full report[/b]", classes="report-title")
            meta_bits = [f"mode={mode}"]
            if audience_label:
                meta_bits.append(f"audience={_markup_escape(audience_label)}")
            if model:
                meta_bits.append(f"model={_markup_escape(model)}")
            if generated_at:
                meta_bits.append(f"generated={_markup_escape(generated_at)}")
            yield Static(
                "[dim]" + "  ·  ".join(meta_bits) + "[/dim]", classes="report-meta"
            )

            yield Static("[b]Executive summary[/b]", classes="report-h")
            yield Static(
                _markup_escape(str(body.get("executive_summary") or "(empty)")),
                classes="report-section",
            )

            yield Static("[b]Verdict[/b]", classes="report-h")
            yield Static(
                f"  [{verdict_style}] {verdict.upper()} [/]    "
                f"[dim]{_markup_escape(str(body.get('verdict_rationale') or ''))}[/dim]",
                classes="report-section",
            )

            yield Static("[b]Original draft[/b]", classes="report-h")
            yield Static(
                f'[dim]"{_markup_escape(self.draft)}"[/dim]',
                classes="report-section",
            )

            yield Static("[b]Audience reception[/b]", classes="report-h")
            for item in body.get("audience_reception") or []:
                arc = str(item.get("archetype") or "lurker")
                tone = str(item.get("tone") or "neutral")
                glyph = ARCH_GLYPH.get(arc, "·")
                ar_style = ARCH_STYLE.get(arc, "white")
                tone_style = TONE_STYLE.get(tone, "dim")
                summary = _markup_escape(str(item.get("summary") or ""))
                quote = _markup_escape(str(item.get("representative_quote") or ""))
                yield Static(
                    f"[{ar_style}]{glyph} {arc:<12}[/]  "
                    f"[{tone_style}]{tone}[/]\n"
                    f"  {summary}\n"
                    f"  [italic dim]“{quote}”[/]",
                    classes="report-card",
                )

            yield Static("[b]Risk vectors[/b]", classes="report-h")
            risks = body.get("risk_vectors") or []
            if not risks:
                yield Static("  [dim](none flagged)[/dim]", classes="report-section")
            for risk in risks:
                sev = str(risk.get("severity") or "low")
                sev_style = SEVERITY_STYLE.get(sev, "dim")
                label = _markup_escape(str(risk.get("label") or ""))
                detail = _markup_escape(str(risk.get("detail") or ""))
                yield Static(
                    f"  [{sev_style}]● {sev.upper():<7}[/]  [bold]{label}[/]\n"
                    f"    {detail}",
                    classes="report-risk",
                )

            yield Static("[b]Rewrite options[/b]", classes="report-h")
            rewrites = body.get("rewrite_options") or []
            if not rewrites:
                yield Static(
                    "  [dim](no rewrites suggested)[/dim]", classes="report-section"
                )
            for i, rw in enumerate(rewrites, 1):
                label = _markup_escape(str(rw.get("label") or ""))
                text = _markup_escape(str(rw.get("text") or ""))
                rationale = _markup_escape(str(rw.get("rationale") or ""))
                yield Static(
                    f"  [bold]{i}. {label}[/]\n"
                    f"    {text}\n"
                    f"    [dim]{rationale}[/dim]",
                    classes="report-rewrite",
                )

            comparable = str(body.get("comparable_discourse") or "").strip()
            if comparable:
                yield Static("[b]Comparable discourse[/b]", classes="report-h")
                yield Static(
                    _markup_escape(comparable), classes="report-section"
                )

            yield Static(
                "\n[dim]press [b]n[/b] for a new simulation · "
                "[b]q[/b] to quit[/dim]",
                classes="report-footer",
            )
        yield Footer()

    def action_new(self) -> None:
        # Pop everything except the root ComposeScreen.
        while len(self.app.screen_stack) > 2:
            self.app.pop_screen()
        # Reset compose state by replacing the root ComposeScreen with a
        # fresh one — the stale TextArea stays useful, but we want a clean
        # error line and a re-focused draft.
        self.app.pop_screen()
        self.app.push_screen(ComposeScreen())

    def action_help(self) -> None:
        self.notify(
            "Report: scrollable. Press n to start a new simulation, q to quit.",
            severity="information",
            timeout=4,
        )


# ----------------------------------------------------------------- App


class EchoTUI(App):
    CSS = """
    Screen { background: $surface; }

    /* ---------------- compose ---------------- */
    #compose-root { padding: 1 2; }
    #compose-title { color: $accent; padding: 1 0 0 0; text-style: bold; }
    #compose-meta { padding: 0 0 1 0; }
    .row { height: auto; padding: 0 0 1 0; align: left middle; }
    .row-label { padding: 0 1 0 1; color: $text-muted; }
    Select { width: 28; margin-right: 1; }
    Checkbox { padding: 0 1; }
    .draft-label { padding: 1 0 0 0; color: $text-muted; }
    #draft { height: 14; border: round $primary; }
    #char-count { padding: 0 0 1 0; }
    #compose-actions { height: 3; align: left middle; padding: 1 0; }
    #run-btn { margin-right: 2; }
    #compose-error { padding: 0 1; }

    /* ---------------- simulate ---------------- */
    #sim-root { padding: 0 1; height: 100%; }
    #sim-post { padding: 1 1; color: $text-muted; }
    #sim-topbar { padding: 0 1 1 1; color: $accent; }
    #sim-cols { height: 1fr; }
    #thread { width: 3fr; padding: 0 1; border: round $primary 30%; }
    #room { width: 1fr; padding: 1 1; border: round $accent 40%; }
    .reply-card { padding: 1 0; border-bottom: dashed $primary 20%; }
    .round-bar { color: $accent; padding: 1 0 0 0; }
    #sim-status { padding: 1 1; height: 2; }

    /* ---------------- report ---------------- */
    #report-root { padding: 1 2; }
    .report-title { color: $accent; padding: 1 0 0 0; text-style: bold; }
    .report-meta { padding: 0 0 1 0; }
    .report-h { color: $accent; padding: 1 0 0 0; text-style: bold; }
    .report-section { padding: 0 1 1 2; }
    .report-card { padding: 1 1; border: round $primary 20%; margin: 0 0 1 0; }
    .report-risk { padding: 0 1 1 1; }
    .report-rewrite { padding: 0 1 1 1; }
    .report-footer { padding: 1 0; }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", priority=True),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.client = EchoClient()

    def on_mount(self) -> None:
        self.title = "Echo · TUI"
        self.sub_title = API_BASE
        self.push_screen(ComposeScreen())

    async def on_unmount(self) -> None:
        try:
            await self.client.aclose()
        except Exception:
            pass


def main() -> int:
    EchoTUI().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
