// Echo views — reworked around the swarm-intelligence flow.
//
//   01 Seed      — set up the persona pool (PDF / X / brief)
//   02 Compose   — write the message + pick rounds
//   03 Rounds    — live swarm thread (agents replying to each other)
//   04 Analysis  — aggregated takeaway: tl;dr, what landed, suggested rewrite
//   05 History   — past simulations
//
// All artboards are 1280×800 — real product scale.

const SEED_DRAFT = "Notion is replacing all-hands with a written weekly memo. Meetings are a tax on focus. We'd rather ship.";

// ─────────────────────────────────────────────────────────────
// Frame — dark app shell wrapper used by every artboard.
// ─────────────────────────────────────────────────────────────
const Frame = ({ children, sidebarActive = 'compose', topbarLabel, topbarRight, contentPad = '32px 48px' }) => (
  <div style={{
    width: 1280, height: 800, display: 'flex',
    background: 'var(--bg)', color: 'var(--fg-1)',
    fontFamily: 'var(--font-sans)', overflow: 'hidden',
  }}>
    <Sidebar active={sidebarActive} onNavigate={() => {}} />
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <FrameTopBar label={topbarLabel} right={topbarRight} />
      <div style={{ flex: 1, overflow: 'hidden', padding: contentPad }}>
        {children}
      </div>
    </main>
  </div>
);

const FrameTopBar = ({ label, right }) => (
  <div style={{
    height: 56, borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', padding: '0 24px', gap: 12,
    background: 'var(--bg)', flexShrink: 0,
  }}>
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)',
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{label}</span>
    {right}
    <div style={{ flex: 1 }} />
    <Avatar initials="ED" size={28} />
  </div>
);

const Eyebrow = ({ children }) => (
  <span style={{
    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
    letterSpacing: '0.06em', textTransform: 'uppercase',
  }}>{children}</span>
);

const PageHeader = ({ eyebrow, title, sub }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 6 }}>
    <Eyebrow>{eyebrow}</Eyebrow>
    <h1 style={{
      margin: 0, fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em',
      lineHeight: 1.15, color: 'var(--fg-1)',
    }}>{title}</h1>
    {sub && <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.5, maxWidth: 620 }}>{sub}</p>}
  </div>
);

// Compact step indicator — dots only, no labels. Lives in the top bar.
const StepIndicator = ({ step }) => {
  const total = 4;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} style={{
          width: i === step ? 18 : 6, height: 6, borderRadius: 999,
          background: i <= step ? 'var(--accent-200)' : 'var(--surface-3)',
          transition: 'width 200ms',
        }} />
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 01 — Seed (set up persona pool)
// ─────────────────────────────────────────────────────────────
const View01_Seed = () => (
  <Frame topbarLabel="Seed" sidebarActive="audience" topbarRight={<StepIndicator step={0} />}>
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Who's in the room?"
        sub="Drop in source material. Echo synthesizes 200 personas." />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <SeedSource
          icon="document"
          title="PDF / docs"
          detail="audience-research.pdf · 24 pages"
          status="active"
          metric="parsed 187 personas"
        />
        <SeedSource
          icon="x"
          title="Connect X"
          detail="@notion · 2.4M followers"
          status="connected"
          metric="sampled 200 / 2.4M"
        />
        <SeedSource
          icon="brief"
          title="Quick brief"
          detail="Describe the audience in 1–3 sentences"
          status="idle"
        />
      </div>

      {/* Pool preview */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Eyebrow>Synthesized persona pool · 200 agents</Eyebrow>
            <div style={{ fontSize: 14, color: 'var(--fg-1)' }}>Notion's product audience · founders, eng leaders, ops folks.</div>
          </div>
          <Button variant="ghost" size="sm">Resample</Button>
        </div>

        {/* Mini agent grid — rows of dots colored by archetype */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(40, 1fr)', gap: 4,
          padding: '10px 0',
        }}>
          {Array.from({ length: 200 }).map((_, i) => {
            const colors = ['#7dd49a','#7dd49a','#9bc97f','#b8b8c0','#b8b8c0','#e8b75a','#f06c5a'];
            const c = colors[i % colors.length];
            return <span key={i} style={{
              width: 8, height: 8, borderRadius: 2, background: c, opacity: 0.85,
            }} />;
          })}
        </div>

        {/* Composition row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
          {[
            { c: '#7dd49a', label: 'Enthusiast',   pct: 28 },
            { c: '#9bc97f', label: 'Practitioner', pct: 18 },
            { c: '#b8b8c0', label: 'Curious',      pct: 24 },
            { c: '#b8b8c0', label: 'Lurker',       pct: 12 },
            { c: '#e8b75a', label: 'Pedant',       pct: 10 },
            { c: '#f06c5a', label: 'Skeptic',      pct: 8  },
          ].map((s) => (
            <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: s.c }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)' }}>{s.pct}%</span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button variant="ghost">Save as preset</Button>
        <Button variant="primary" icon={<Icon name="arrowUpRight" size={12} />}>Use this audience</Button>
      </div>
    </div>
  </Frame>
);

const SeedSource = ({ icon, title, detail, status, metric }) => {
  const isActive = status === 'active';
  const isConnected = status === 'connected';
  const ring = isActive ? '1px solid var(--accent-300)' : '1px solid var(--border)';
  return (
    <div style={{
      background: 'var(--surface)', border: ring, borderRadius: 12, padding: 16,
      display: 'flex', flexDirection: 'column', gap: 10, position: 'relative',
    }}>
      {isActive && (
        <span style={{
          position: 'absolute', top: -10, right: 12,
          background: 'var(--accent-200)', color: '#0a0c00',
          padding: '2px 8px', borderRadius: 999,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Active</span>
      )}
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-1)',
      }}>
        {icon === 'document' && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>}
        {icon === 'x' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>𝕏</span>}
        {icon === 'brief' && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h12"/></svg>}
      </div>
      <div>
        <div style={{ fontSize: 14, color: 'var(--fg-1)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{detail}</div>
      </div>
      {metric && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)', marginTop: 'auto' }}>{metric}</div>}
      {status === 'idle' && <Button variant="secondary" size="sm" style={{ alignSelf: 'flex-start' }}>Add</Button>}
      {isConnected && <Badge tone="positive" dot>Connected</Badge>}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 02 — Compose (write the message + pick rounds)
// ─────────────────────────────────────────────────────────────
const View02_Compose = () => (
  <Frame topbarLabel="Compose" sidebarActive="compose" topbarRight={<StepIndicator step={1} />}>
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="What are you posting?"
        sub="200 agents react, then react to each other." />
      <Composer
        draft={SEED_DRAFT}
        setDraft={() => {}}
        audience={"Notion · 200 agents"}
        onRun={() => {}}
      />

      {/* Rounds picker — compact slider-style */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{ fontSize: 13, color: 'var(--fg-1)' }}>Rounds</div>
        <div style={{ flex: 1, display: 'flex', gap: 6 }}>
          {[3, 5, 8, 12, 20].map((n) => (
            <span key={n} style={{
              flex: 1, textAlign: 'center',
              padding: '8px 0', borderRadius: 6, fontSize: 13,
              background: n === 5 ? 'var(--surface-2)' : 'transparent',
              border: '1px solid ' + (n === 5 ? 'var(--border-strong)' : 'var(--border)'),
              color: n === 5 ? 'var(--fg-1)' : 'var(--fg-2)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}>{n}</span>
          ))}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>~90s</span>
      </div>
    </div>
  </Frame>
);

// ─────────────────────────────────────────────────────────────
// 03 — Rounds (live swarm thread)
// ─────────────────────────────────────────────────────────────
const View03_Rounds = ({ currentRound = 5, running = true }) => (
  <Frame
    topbarLabel={running ? `Round ${currentRound} of 5` : 'Simulation complete'}
    sidebarActive="compose"
    topbarRight={
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {running && <span style={{
          width: 6, height: 6, borderRadius: 999, background: 'var(--accent-200)',
          animationName: 'echo-pulse', animationDuration: '1.4s', animationIterationCount: 'infinite',
        }} />}
        <StepIndicator step={2} />
      </div>
    }
    contentPad="20px 24px"
  >
    <div style={{
      maxWidth: 1200, margin: '0 auto',
      display: 'flex', flexDirection: 'column', gap: 14, height: '100%',
    }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SwarmThread
          currentRound={currentRound}
          maxRounds={5}
          seedDraft={SEED_DRAFT}
          running={running}
        />
      </div>
      {running && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" icon={<Icon name="pause" size={11} />}>Pause</Button>
        </div>
      )}
    </div>
  </Frame>
);

// ─────────────────────────────────────────────────────────────
// 04 — Analysis (aggregated takeaway)
// ─────────────────────────────────────────────────────────────
const View04_Analysis = () => (
  <Frame
    topbarLabel="Analysis"
    sidebarActive="compose"
    topbarRight={<StepIndicator step={3} />}
  >
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Headline takeaway */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: '2px solid var(--accent-200)',
        borderRadius: 12, padding: 24,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <p style={{
          margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic',
          fontSize: 28, lineHeight: 1.3, color: 'var(--fg-1)', letterSpacing: '-0.01em',
        }}>
          The idea lands. <span style={{ fontStyle: 'normal', fontFamily: 'var(--font-sans)' }}>The phrasing</span> doesn't.
        </p>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Skeptics aren't pushing back on the substance — they're pushing back on "meetings are a tax on focus" reading as absolutist. By round 4, consensus formed: change the phrasing, keep the substance.
        </p>
      </div>

      {/* Suggested rewrite */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="sparkles" size={14} style={{ color: 'var(--accent-200)' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>Suggested rewrite</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{
            background: 'var(--bg-deep)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 12,
          }}>
            <Eyebrow>Original</Eyebrow>
            <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, marginTop: 8 }}>
              Notion is replacing all-hands with a written weekly memo. <s style={{ color: 'var(--fg-3)' }}>Meetings are a tax on focus.</s> We'd rather ship.
            </div>
          </div>
          <div style={{
            background: 'rgba(212,255,92,0.06)', border: '1px solid rgba(212,255,92,0.25)',
            borderRadius: 8, padding: 12,
          }}>
            <Eyebrow>Rewrite</Eyebrow>
            <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.5, marginTop: 8 }}>
              Trying something at Notion: replacing the weekly all-hands with a written memo. We want to give the team back focus time and let writing do the alignment work.
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" size="sm">Use rewrite</Button>
          <Button variant="ghost" size="sm">Show 2 more</Button>
        </div>
      </div>

      {/* Reply chains worth reading */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)', marginBottom: 6 }}>Worth reading</div>
        {[
          { color: '#f06c5a', label: 'Skeptic dogpile',
            tldr: '"Monthly is just shorter quarters" — challenges the cadence framing, not the writing.' },
          { color: '#9bc97f', label: 'Practitioner save',
            tldr: 'Sales-context counter-example — they tried it, what stayed live, what became a memo.' },
          { color: '#7dd49a', label: 'Consensus emerging',
            tldr: '"Change the phrasing, keep the substance."' },
        ].map((c, i) => (
          <div key={c.label} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 0',
            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            cursor: 'pointer',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--fg-2)', minWidth: 130, flexShrink: 0 }}>{c.label}</span>
            <span style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.45, flex: 1 }}>{c.tldr}</span>
            <Icon name="arrowUpRight" size={12} style={{ color: 'var(--fg-3)' }} />
          </div>
        ))}
      </div>

      {/* Footer actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
        <Button variant="ghost" icon={<Icon name="refresh" size={13} />}>Re-run</Button>
        <div style={{ flex: 1 }} />
        <Button variant="secondary">Edit draft</Button>
        <Button variant="primary">Publish</Button>
      </div>
    </div>
  </Frame>
);

const StatCallout = () => null;

// ─────────────────────────────────────────────────────────────
// 05 — History
// ─────────────────────────────────────────────────────────────
const View05_History = () => {
  const items = [
    { draft: "Notion is replacing all-hands with a written weekly memo. Meetings are a tax on focus. We'd rather ship.", sentiment: 0.04, replies: 17, rounds: 5, when: '4 seconds ago', tone: 'caution' },
    { draft: "we're done with quarterly OKRs. shipping monthly.", sentiment: 0.34, replies: 24, rounds: 5, when: '2 hours ago', tone: 'caution' },
    { draft: "hot take: most design systems are just CSS reset packages with extra steps.", sentiment: -0.18, replies: 41, rounds: 8, when: 'yesterday', tone: 'danger' },
    { draft: "Echo just shipped: paste a draft, see the replies before you post.", sentiment: 0.62, replies: 19, rounds: 5, when: '3 days ago', tone: 'positive' },
    { draft: "calling it now: the next decade of software is built around feedback loops, not features.", sentiment: 0.41, replies: 30, rounds: 8, when: 'last week', tone: 'positive' },
  ];
  return (
    <Frame topbarLabel="History" sidebarActive="history">
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Past simulations"
        sub="Click any to see the analysis." />

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {['All · 14', 'Low risk · 6', 'Mild · 5', 'High risk · 3'].map((t, i) => (
            <span key={t} style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12,
              background: i === 0 ? 'var(--surface-2)' : 'transparent',
              color: i === 0 ? 'var(--fg-1)' : 'var(--fg-3)',
              border: i === 0 ? '1px solid var(--border-strong)' : '1px solid var(--border)',
              cursor: 'pointer',
            }}>{t}</span>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((h, i) => (
            <div key={i} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 16, cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.45 }}>{h.draft}</div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', flexWrap: 'wrap' }}>
                <Badge tone={h.tone} dot>
                  {h.tone === 'positive' ? 'Low risk' : h.tone === 'caution' ? 'Mild ratio risk' : 'High ratio risk'}
                </Badge>
                <span style={{ color: h.sentiment >= 0 ? '#7dd49a' : '#f06c5a' }}>
                  {h.sentiment >= 0 ? '+' : ''}{h.sentiment.toFixed(2)}
                </span>
                <span>{h.replies} replies · {h.rounds} rounds</span>
                <span style={{ marginLeft: 'auto' }}>{h.when}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
};

Object.assign(window, {
  View01_Seed, View02_Compose, View03_Rounds, View04_Analysis, View05_History,
  SEED_DRAFT,
});
