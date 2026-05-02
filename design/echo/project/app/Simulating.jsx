// Simulating — force-graph upgrade. Agents as nodes, replies as edges firing in.
// Static snapshot: ~70% through a run.

const SimNode = ({ x, y, lit, accent, size = 2.4 }) => (
  <circle cx={x} cy={y} r={size}
    fill={accent ? '#d4ff5c' : lit ? '#b8b8c0' : '#2e2e34'}
    opacity={accent ? 0.95 : lit ? 0.7 : 0.45}
    style={accent ? { animation: 'echo-pulse 1.6s var(--ease-in-out) infinite' } : null}
  />
);

const Simulating = ({ progress = 0.68, count = 137, round = 41 }) => {
  // Generate force-directed-looking layout (deterministic, no JS sim).
  const { nodes, edges } = React.useMemo(() => {
    const n = 200;
    const arr = [];
    // 4 clusters: 4 archetypes loosely grouped.
    const centers = [{x: -120, y: -50}, {x: 110, y: -70}, {x: -80, y: 70}, {x: 130, y: 60}];
    for (let i = 0; i < n; i++) {
      const c = centers[i % 4];
      const r = 30 + Math.random ? 0 : 0; // deterministic
      const a = (i * 137.5) % 360 * Math.PI / 180;
      const dist = 12 + ((i * 17) % 70);
      arr.push({
        x: c.x + Math.cos(a) * dist + ((i * 7) % 21 - 10),
        y: c.y + Math.sin(a) * dist + ((i * 11) % 19 - 9),
        cluster: i % 4,
        order: (i * 53) % n,
      });
    }
    // Edges: for first ~count nodes, connect each to a nearby node.
    const e = [];
    arr.forEach((nd, i) => {
      if (nd.order < count) {
        const j = (i + 1 + (i % 7)) % n;
        e.push({ x1: nd.x, y1: nd.y, x2: arr[j].x, y2: arr[j].y, sentiment: ((i * 31) % 100) / 100 - 0.4 });
      }
    });
    return { nodes: arr, edges: e };
  }, [count]);

  const sentimentValue = -0.08; // mid-run reading

  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <TopNav active="compose" audience="Notion · core" />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: collapsed draft + live readouts */}
        <div style={{ width: 360, borderRight: '1px solid var(--border)', padding: 28, display: 'flex', flexDirection: 'column', gap: 18, overflow: 'auto' }}>
          <Eyebrow>Draft · running</Eyebrow>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.45 }}>
            {window.SAMPLE_DRAFT}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Eyebrow>Live readout</Eyebrow>
            <ReadStat label="Agents responded" value={`${count}`} sub="of 200" />
            <ReadStat label="Mean sentiment" value={`${sentimentValue >= 0 ? '+' : ''}${sentimentValue.toFixed(2)}`} sub="trending down" color="#f06c5a" trend="down" />
            <ReadStat label="Risk flags raised" value="2" sub="2 new this round" color="#e8b75a" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <Eyebrow>Round {round} of 60</Eyebrow>
            <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progress * 100}%`, height: '100%', background: 'var(--accent-200)', transition: 'width 200ms linear' }} />
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>~{Math.round((1 - progress) * 60)}s remaining</span>
          </div>
          <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start' }} icon={<Icon name="x" size={12} />}>Cancel run</Button>
        </div>
        {/* Right: the network canvas */}
        <div style={{ flex: 1, position: 'relative', background: 'var(--bg-deep)', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 24, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            {/* Sentiment needle in corner */}
            <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 2, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge tone="accent" dot pulse>Live · 200 agents</Badge>
            </div>
            <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 2, display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 999, padding: '6px 12px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Sentiment</span>
              <NeedleMini value={sentimentValue} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#f06c5a' }}>{sentimentValue >= 0 ? '+' : ''}{sentimentValue.toFixed(2)}</span>
            </div>
            {/* Counter, center */}
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', zIndex: 1, pointerEvents: 'none' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 64, fontWeight: 500, color: 'var(--fg-1)', letterSpacing: '-0.04em', lineHeight: 1 }}>
                {count}<span style={{ color: 'var(--fg-4)', fontSize: 22 }}> / 200</span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 6 }}>
                Agents reacting
              </div>
            </div>
            <svg viewBox="-220 -150 440 300" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
              <defs>
                <radialGradient id="sim-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#d4ff5c" stopOpacity="0.06" />
                  <stop offset="100%" stopColor="#d4ff5c" stopOpacity="0" />
                </radialGradient>
              </defs>
              <rect x="-220" y="-150" width="440" height="300" fill="url(#sim-glow)" />
              {/* Edges */}
              {edges.map((e, i) => (
                <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke={e.sentiment > 0.1 ? 'rgba(125,212,154,0.18)' : e.sentiment < -0.1 ? 'rgba(240,108,90,0.18)' : 'rgba(184,184,192,0.10)'}
                  strokeWidth="0.6" />
              ))}
              {/* Ripples from center */}
              {[1,2,3].map(r => (
                <circle key={r} cx="0" cy="0" r={r * 35} fill="none" stroke="rgba(212,255,92,0.10)" strokeWidth="1"
                  style={{ animation: `echo-ripple ${2.2 + r * 0.4}s var(--ease-out) infinite`, animationDelay: `${r * 0.35}s`, transformOrigin: 'center' }} />
              ))}
              {/* Nodes */}
              {nodes.map((n, i) => {
                const visible = n.order < count;
                const accent = visible && i % 11 === 0;
                return <SimNode key={i} x={n.x} y={n.y} lit={visible} accent={accent} />;
              })}
            </svg>
            {/* Streaming reply preview, bottom */}
            <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 2 }}>
              <Eyebrow>Latest replies</Eyebrow>
              {[
                { h: '@audrey_lin', t: 'killing toggles is a "we know better" move…', s: -0.42 },
                { h: '@mreid', t: 'fewer primitives, more composition. right call.', s: 0.51 },
              ].map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>{r.h}</span>
                  <span style={{ flex: 1, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.t}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: r.s > 0 ? '#7dd49a' : '#f06c5a' }}>{r.s >= 0 ? '+' : ''}{r.s.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ReadStat = ({ label, value, sub, color, trend }) => (
  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color: color || 'var(--fg-1)' }}>{value}</span>
      {trend === 'down' && <Icon name="trendingDown" size={12} style={{ color: '#f06c5a' }} />}
    </div>
    {sub && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-4)' }}>{sub}</span>}
  </div>
);

const NeedleMini = ({ value }) => {
  const pct = ((value + 1) / 2) * 100;
  return (
    <div style={{ position: 'relative', width: 80, height: 6, borderRadius: 999,
      background: 'linear-gradient(to right, #f06c5a 0%, #b8b8c0 50%, #7dd49a 100%)' }}>
      <div style={{ position: 'absolute', top: -3, left: `${pct}%`, width: 3, height: 12, background: 'var(--fg-1)', borderRadius: 1, transform: 'translateX(-1.5px)' }} />
    </div>
  );
};

Object.assign(window, { Simulating, NeedleMini, ReadStat });
