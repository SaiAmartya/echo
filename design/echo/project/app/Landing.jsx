// Landing — first-time hero with ambient ripple viz, plus dashboard variant.

const AmbientViz = () => {
  // Slow ambient ripple loop. Lime nodes faintly pulsing in the bg.
  const nodes = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2 + (i % 5) * 0.3;
      const r = 70 + (i % 6) * 22;
      arr.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, d: (i * 71) % 2400, lit: i % 3 === 0 });
    }
    return arr;
  }, []);
  return (
    <svg viewBox="-220 -160 440 320" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <defs>
        <radialGradient id="ambient-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#d4ff5c" stopOpacity="0.10" />
          <stop offset="60%" stopColor="#d4ff5c" stopOpacity="0.02" />
          <stop offset="100%" stopColor="#d4ff5c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="-220" y="-160" width="440" height="320" fill="url(#ambient-glow)" />
      {[1,2,3,4].map(r => (
        <circle key={r} cx="0" cy="0" r={r * 38} fill="none"
          stroke="rgba(212,255,92,0.10)" strokeWidth="1"
          style={{ animation: `echo-ripple ${3 + r * 0.6}s var(--ease-out) infinite`, animationDelay: `${r * 0.5}s`, transformOrigin: 'center' }} />
      ))}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.lit ? 1.6 : 1.2}
          fill={n.lit ? '#d4ff5c' : '#43434b'} opacity={n.lit ? 0.7 : 0.35}
          style={{ animation: n.lit ? `echo-pulse 2.4s var(--ease-in-out) infinite` : 'none', animationDelay: `${n.d}ms` }} />
      ))}
    </svg>
  );
};

const Landing = () => (
  <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <div style={{
      height: 56, padding: '0 32px', display: 'flex', alignItems: 'center', gap: 16,
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <EchoMark size={22} />
        <span style={{ fontWeight: 500, fontSize: 16, letterSpacing: '-0.02em' }}>echo</span>
      </div>
      <div style={{ flex: 1 }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>private beta · v0.4</span>
      <Button variant="ghost" size="sm">Sign in</Button>
    </div>
    <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 32px' }}>
      <AmbientViz />
      <div style={{ position: 'relative', maxWidth: 720, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-200)',
          letterSpacing: '0.08em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent-200)', animation: 'echo-pulse 1.6s var(--ease-in-out) infinite' }} />
          Pre-flight check for social posts
        </span>
        <h1 style={{
          margin: 0, fontSize: 56, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1.05, color: 'var(--fg-1)',
        }}>
          Post like you've{' '}
          <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 400 }}>already seen</span>{' '}
          the replies.
        </h1>
        <p style={{ margin: 0, fontSize: 17, color: 'var(--fg-2)', lineHeight: 1.5, maxWidth: 540 }}>
          Paste a draft. <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-1)' }}>200 agents</span>, seeded from your real audience, run a 60-second simulated thread. See the ratio before it happens.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <Button variant="primary" size="lg" icon={<Icon name="play" size={13} />}>Try a sample</Button>
          <Button variant="secondary" size="lg">Start with your audience</Button>
        </div>
        <div style={{ display: 'flex', gap: 24, marginTop: 16, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
          <span><span style={{ color: 'var(--fg-1)' }}>60s</span> per simulation</span>
          <span><span style={{ color: 'var(--fg-1)' }}>200</span> agents per run</span>
          <span><span style={{ color: 'var(--fg-1)' }}>1,400+</span> posts triaged this week</span>
        </div>
      </div>
    </div>
  </div>
);

const Dashboard = () => (
  <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
    <TopNav active="compose" audience="Notion · core" />
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 48px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Eyebrow>Welcome back</Eyebrow>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
              Got a draft? <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 400, color: 'var(--fg-2)' }}>Let's read the room.</span>
            </h1>
          </div>
          <Button variant="primary" icon={<Icon name="plus" size={13} />}>New run</Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {[
            { k: 'Runs this month', v: '14', sub: '/ 25 included' },
            { k: 'Mean sentiment', v: '+0.21', sub: 'last 14 runs', color: '#7dd49a' },
            { k: 'Drafts rewritten', v: '6', sub: '43% of risky drafts' },
          ].map((s,i) => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Eyebrow>{s.k}</Eyebrow>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, color: s.color || 'var(--fg-1)' }}>{s.v}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{s.sub}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Recent runs</h3>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>5 of 47</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {window.HISTORY.map((h, i) => <RunCard key={i} h={h} />)}
        </div>
      </div>
    </div>
  </div>
);

const RunCard = ({ h }) => {
  const colors = { positive: '#7dd49a', caution: '#e8b75a', danger: '#f06c5a' };
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 3, background: colors[h.tone] }} />
      <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.45, paddingLeft: 4,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{h.draft}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
        <span style={{ color: colors[h.tone] }}>{h.sentiment >= 0 ? '+' : ''}{h.sentiment.toFixed(2)}</span>
        <span>·</span>
        <span>{h.replies} replies</span>
        {h.flags > 0 && <><span>·</span><span style={{ color: '#e8b75a' }}>{h.flags} flag{h.flags === 1 ? '' : 's'}</span></>}
        <span style={{ marginLeft: 'auto' }}>{h.when}</span>
      </div>
    </div>
  );
};

Object.assign(window, { Landing, Dashboard, AmbientViz, RunCard });
