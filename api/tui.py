"""Echo TUI — terminal control plane for the swarm engine.

Mirrors the web flow without a browser:
  compose screen  → enter draft, rounds, audience preset; press R to run
  simulate screen → live thread (left) + "the room" stats (right) as replies stream
  report screen   → headline + suggested rewrite + worth-reading chains

Keys (global):
  q       quit
  n       new simulation (back to compose)
  ?       toggle help
  ctrl+c  hard quit

Run:
  python -m api.tui
"""
from __future__ import annotations

import asyncio
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(Path(__file__).parent / ".env")
except Exception:
    pass

from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.reactive import reactive
from textual.screen import Screen
from textual.widgets import (
    Button,
    Footer,
    Header,
    Input,
    Label,
    ProgressBar,
    Select,
    Static,
    TextArea,
)

from .engine.archetypes import Archetype, ARCHETYPE_MIX
from .engine.llm import LLMError, generate_analysis
from .engine.round_loop import run_simulation
from .engine.schemas import Analysis, AssignedReply, AudienceProfile


# ----------------------------------------------------------------- audience presets

AUDIENCE_PRESETS: dict[str, AudienceProfile] = {
    "notion": AudienceProfile(
        demographics="knowledge workers, PMs, founders, writers; 25-45; SF/NY/remote",
        pain_points=["tool sprawl", "context switching", "shallow AI features"],
        vocabulary=["second brain", "blocks", "databases", "workspace"],
        recurring_opinions=["lukewarm on Notion AI", "love the flexibility, hate the bloat"],
    ),
    "yc-startup": AudienceProfile(
        demographics="seed-stage founders, early eng hires, technical operators",
        pain_points=["finding PMF", "fundraising distraction", "premature scaling"],
        vocabulary=["ICP", "design partner", "ramen profitable", "ship fast"],
        recurring_opinions=["pmf is a feeling", "wrappers are fine if they ship"],
    ),
    "creator": AudienceProfile(
        demographics="indie creators, newsletter writers, small audiences (<50k)",
        pain_points=["audience growth", "monetization", "platform churn"],
        vocabulary=["beehiiv", "substack", "open rate", "engagement"],
        recurring_opinions=["algorithms can't be trusted", "owned audience > rented"],
    ),
}


# ----------------------------------------------------------------- archetype glyphs

ARCH_GLYPH = {
    Archetype.ENTHUSIAST:   "★",
    Archetype.PRACTITIONER: "◆",
    Archetype.CURIOUS:      "?",
    Archetype.LURKER:       "·",
    Archetype.PEDANT:       "※",
    Archetype.SKEPTIC:      "✗",
}

ARCH_STYLE = {
    Archetype.ENTHUSIAST:   "bold green",
    Archetype.PRACTITIONER: "bold blue",
    Archetype.CURIOUS:      "bold cyan",
    Archetype.LURKER:       "dim white",
    Archetype.PEDANT:       "bold magenta",
    Archetype.SKEPTIC:      "bold red",
}


def sentiment_style(s: float) -> str:
    if s >= 0.3:
        return "green"
    if s <= -0.3:
        return "red"
    return "yellow"


# ----------------------------------------------------------------- compose screen


class ComposeScreen(Screen):
    BINDINGS = [
        Binding("ctrl+r", "run", "Run simulation"),
        Binding("q", "app.quit", "Quit"),
        Binding("?", "help", "Help"),
    ]

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="compose-root"):
            yield Label("[b]Echo · compose[/b]", id="compose-title")
            yield Label("Draft post:")
            yield TextArea("", id="draft", language="markdown")
            with Horizontal(id="compose-row"):
                yield Label("Rounds:", classes="row-label")
                yield Input(value="5", id="rounds", restrict=r"[0-9]*", classes="num-input")
                yield Label("Audience:", classes="row-label")
                yield Select(
                    [(k, k) for k in (["none"] + list(AUDIENCE_PRESETS.keys()))],
                    value="none",
                    id="audience",
                    allow_blank=False,
                )
                yield Button("Run (Ctrl+R)", variant="primary", id="run-btn")
            yield Static("", id="compose-error")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#draft", TextArea).focus()

    @on(Button.Pressed, "#run-btn")
    def _on_run_button(self) -> None:
        self.action_run()

    def action_run(self) -> None:
        draft = self.query_one("#draft", TextArea).text.strip()
        rounds_raw = self.query_one("#rounds", Input).value.strip() or "5"
        audience_raw = self.query_one("#audience", Select).value
        audience_key = audience_raw if isinstance(audience_raw, str) else "none"
        err = self.query_one("#compose-error", Static)
        if not draft:
            err.update("[red]draft is empty[/red]")
            return
        try:
            rounds = int(rounds_raw)
        except ValueError:
            err.update("[red]rounds must be a number[/red]")
            return
        if not (1 <= rounds <= 20):
            err.update("[red]rounds must be 1–20[/red]")
            return
        audience = AUDIENCE_PRESETS.get(audience_key) if audience_key != "none" else None
        self.app.push_screen(SimulateScreen(draft, rounds, audience))

    def action_help(self) -> None:
        self.notify(
            "Compose: write a draft, pick rounds + audience, Ctrl+R to run.",
            severity="information",
            timeout=4,
        )


# ----------------------------------------------------------------- thread + room widgets


class ThreadFeed(VerticalScroll):
    """Streaming reply list — append-only."""

    def append_reply(self, r: AssignedReply) -> None:
        glyph = ARCH_GLYPH[r.archetype]
        ar_style = ARCH_STYLE[r.archetype]
        sent = f"[{sentiment_style(r.sentiment)}]{r.sentiment:+.2f}[/]"
        flags = []
        if r.is_dogpile_starter:
            flags.append("[yellow]★dogpile[/yellow]")
        if r.audience_flag == "target":
            flags.append("[cyan]audience[/cyan]")
        flag_str = ("  " + " ".join(flags)) if flags else ""
        reply_to = (
            f"  [dim]↳ {r.replying_to_id}[/dim]" if r.replying_to_id else ""
        )
        block = (
            f"[{ar_style}]{glyph} {r.archetype.value:<12}[/] "
            f"[bold]@{r.persona_handle}[/]  {sent}  "
            f"[dim]r{r.round_num} · {r.id}[/dim]{flag_str}{reply_to}\n"
            f"  {r.text}"
        )
        widget = Static(block, classes="reply-card")
        self.mount(widget)
        self.scroll_end(animate=False)

    def add_round_marker(self, n: int) -> None:
        bar = "─" * 6
        self.mount(Static(f"\n[bold]{bar} round {n} {bar}[/bold]\n", classes="round-bar"))
        self.scroll_end(animate=False)


class RoomPanel(Static):
    """Right panel — live archetype/sentiment summary."""

    counts: reactive[dict] = reactive(dict)
    sentiments: reactive[list[float]] = reactive(list)
    round_num: reactive[int] = reactive(0)
    total: reactive[int] = reactive(0)
    target_count: reactive[int] = reactive(0)

    def render(self) -> str:
        lines = ["[b]The room[/b]\n"]
        lines.append(f"[dim]round[/dim]   {self.round_num}")
        lines.append(f"[dim]replies[/dim] {self.total}")
        lines.append(f"[dim]target[/dim]  {self.target_count} · [dim]public[/dim] {self.total - self.target_count}")
        if self.sentiments:
            avg = sum(self.sentiments) / len(self.sentiments)
            lines.append(f"[dim]mean[/dim]    [{sentiment_style(avg)}]{avg:+.2f}[/]")
        lines.append("")
        lines.append("[b]archetypes[/b]")
        max_count = max(self.counts.values()) if self.counts else 1
        for a in Archetype:
            n = self.counts.get(a, 0)
            bar_len = int(20 * n / max_count) if max_count else 0
            bar = "█" * bar_len
            style = ARCH_STYLE[a]
            lines.append(f"  [{style}]{ARCH_GLYPH[a]} {a.value:<12}[/] [{style}]{bar}[/] [dim]{n}[/dim]")
        lines.append("")
        lines.append("[dim]target mix:[/dim]")
        for a in Archetype:
            pct = int(ARCHETYPE_MIX[a] * 100)
            lines.append(f"  {ARCH_GLYPH[a]} {a.value:<12} {pct}%")
        return "\n".join(lines)


# ----------------------------------------------------------------- simulate screen


class SimulateScreen(Screen):
    BINDINGS = [
        Binding("s", "stop", "Stop"),
        Binding("n", "back", "New"),
        Binding("q", "app.quit", "Quit"),
        Binding("a", "show_analysis", "Analysis"),
    ]

    def __init__(self, draft: str, rounds: int, audience: Optional[AudienceProfile]) -> None:
        super().__init__()
        self.draft = draft
        self.rounds = rounds
        self.audience = audience
        self.all_replies: list[AssignedReply] = []
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._analysis: Optional[Analysis] = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="sim-root"):
            yield Static(f'[b]post:[/b] "{self.draft[:160]}{"…" if len(self.draft) > 160 else ""}"', id="sim-post")
            yield ProgressBar(total=self.rounds, show_eta=False, id="sim-progress")
            with Horizontal(id="sim-cols"):
                yield ThreadFeed(id="thread")
                yield RoomPanel(id="room")
            yield Static("", id="sim-status")
        yield Footer()

    def on_mount(self) -> None:
        import os as _os
        if not _os.environ.get("GEMINI_API_KEY"):
            self.query_one("#sim-status", Static).update(
                "[red]GEMINI_API_KEY not set — add it to api/.env and restart[/red]"
            )
            return
        self._task = asyncio.create_task(self._drive())

    async def _drive(self) -> None:
        thread = self.query_one(ThreadFeed)
        room = self.query_one(RoomPanel)
        progress = self.query_one(ProgressBar)
        status = self.query_one("#sim-status", Static)
        counts: Counter[Archetype] = Counter()
        sentiments: list[float] = []
        target_count = 0

        try:
            async for ev in run_simulation(
                post=self.draft,
                rounds=self.rounds,
                audience_profile=self.audience,
                seed=None,
            ):
                if self._stopped:
                    break
                if ev.type == "round_start":
                    n = ev.round_num or 0
                    thread.add_round_marker(n)
                    room.round_num = n
                elif ev.type == "reply" and ev.reply is not None:
                    r = ev.reply
                    self.all_replies.append(r)
                    counts[r.archetype] += 1
                    sentiments.append(r.sentiment)
                    if r.audience_flag == "target":
                        target_count += 1
                    room.counts = dict(counts)
                    room.sentiments = list(sentiments)
                    room.total = len(sentiments)
                    room.target_count = target_count
                    thread.append_reply(r)
                elif ev.type == "round_complete":
                    progress.advance(1)
                elif ev.type == "analysis_ready":
                    status.update("[dim]rounds complete · generating analysis…[/dim]")
                elif ev.type == "error":
                    status.update(f"[red]engine error: {ev.message}[/red]")
                    return
        except LLMError as e:
            status.update(f"[red]LLM error: {e}[/red]")
            return

        if self._stopped:
            status.update("[yellow]stopped[/yellow]")
            return

        if not self.all_replies:
            status.update("[yellow]no replies generated[/yellow]")
            return

        # Final analysis (Gemini analysis model).
        try:
            self._analysis = await generate_analysis(self.draft, self.all_replies, self.audience)
            status.update("[green]done · press [b]a[/b] for analysis · [b]n[/b] for new sim[/green]")
        except LLMError as e:
            status.update(f"[yellow]done — analysis failed: {e}[/yellow]")
        except Exception as e:
            status.update(f"[yellow]done — analysis failed: {e}[/yellow]")

    def action_stop(self) -> None:
        self._stopped = True
        if self._task and not self._task.done():
            self._task.cancel()
        self.query_one("#sim-status", Static).update("[yellow]stopping…[/yellow]")

    def action_back(self) -> None:
        self.action_stop()
        self.app.pop_screen()

    def action_show_analysis(self) -> None:
        if self._analysis is None:
            self.notify("analysis not ready yet", severity="warning", timeout=2)
            return
        self.app.push_screen(ReportScreen(self._analysis, self.draft))


# ----------------------------------------------------------------- report screen


class ReportScreen(Screen):
    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back"),
        Binding("n", "new", "New"),
        Binding("q", "app.quit", "Quit"),
    ]

    def __init__(self, analysis: Analysis, draft: str) -> None:
        super().__init__()
        self.analysis = analysis
        self.draft = draft

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="report-root"):
            yield Static("[b]Analysis[/b]", classes="report-h")
            yield Static(f'[dim]original:[/dim] "{self.draft}"', classes="report-section")
            yield Static("[b]Headline[/b]", classes="report-h")
            yield Static(self.analysis.headline, classes="report-section")
            yield Static("[b]Suggested rewrite[/b]", classes="report-h")
            yield Static(self.analysis.suggested_rewrite, classes="report-section")
            yield Static("[b]Worth reading[/b]", classes="report-h")
            for i, ch in enumerate(self.analysis.chains, 1):
                yield Static(
                    f"  {i}. [dim]{ch.root_reply_id}[/dim] — {ch.rationale}",
                    classes="report-chain",
                )
        yield Footer()

    def action_new(self) -> None:
        # Pop back to compose by popping until we hit it.
        while len(self.app.screen_stack) > 1:
            self.app.pop_screen()


# ----------------------------------------------------------------- app


class EchoTUI(App):
    CSS = """
    Screen { background: $surface; }

    #compose-root { padding: 1 2; }
    #compose-title { color: $accent; padding: 1 0; text-style: bold; }
    #draft { height: 12; border: round $primary; }
    #compose-row { height: 3; align: left middle; padding: 1 0; }
    .row-label { padding: 0 1; color: $text-muted; }
    .num-input { width: 8; }
    #audience { width: 22; }
    #run-btn { margin-left: 2; }
    #compose-error { padding: 1 0; height: 2; }

    #sim-root { padding: 0 1; height: 100%; }
    #sim-post { padding: 1 1; color: $text-muted; }
    #sim-progress { margin: 0 1; }
    #sim-cols { height: 1fr; }
    #thread { width: 2fr; padding: 0 1; border: round $primary 30%; }
    #room { width: 1fr; padding: 1 1; border: round $accent 40%; }
    .reply-card { padding: 1 0; border-bottom: dashed $primary 20%; }
    .round-bar { color: $accent; padding: 1 0 0 0; }
    #sim-status { padding: 1 1; height: 2; }

    #report-root { padding: 1 2; }
    .report-h { color: $accent; padding: 1 0 0 0; text-style: bold; }
    .report-section { padding: 0 1 1 2; }
    .report-chain { padding: 0 1; }
    """

    BINDINGS = [Binding("ctrl+c", "quit", "Quit", priority=True)]

    def on_mount(self) -> None:
        self.title = "Echo · TUI"
        self.push_screen(ComposeScreen())


def main() -> int:
    EchoTUI().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
