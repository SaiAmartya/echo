// SimulationCanvasPro — upgraded simulation viz.
// Force-directed agent swarm. Nodes light up in waves as agents respond.
// Edges fire when their reply streams in. Sentiment needle in the corner
// drifts live as the running mean changes. Replies overlay the canvas mid-run.
//
// Style: keeps the existing kit's "subtle pulses only" motion vocabulary —
// the upgrade is structural (real layout, real edges, real needle), not
// flashier. Per design system: lime accent, warm neutrals, mono numerals.

const SimulationCanvasPro = ({
  progress,           // 0..1
  count,              // 0..200
  total = 200,
  draft,              // current draft text (for the inline echo)
  streamingReplies,   // [{i, name, handle, text, sentiment}]
  vizStyle = 'graph', // 'graph' | 'radial' | 'waveform'
  height = 380,
}) => {
  const W = 720, H = height;
  const cx = 0, cy = 0;

  // Stable agent layout — force-graph-flavored: 6 archetype clusters, each
  // a soft blob orbiting the center. Computed once, reused across renders.
  const agents = React.useMemo(() => {
    const ARCHETYPES = [
      { id: 'enthusiast',   angle: -Math.PI / 2,        r: 110, hue: 'pos' },
      { id: 'practitioner', angle: -Math.PI / 6,        r: 130, hue: 'mid' },
      { id: 'curious',      angle:  Math.PI / 6,        r: 120, hue: 'mid' },
      { id: 'skeptic',      angle:  Math.PI / 2,        r: 130, hue: 'neg' },
      { id: 'pedant',       angle:  Math.PI - Math.PI/6,r: 120, hue: 'neg' },
      { id: 'lurker',       angle: -Math.PI + Math.PI/6,r: 110, hue: 'mid' },
    ];
    const arr = [];
    let i = 0;
    ARCHETYPES.forEach((arch, ai) => {
      const cluster = total / ARCHETYPES.length;
      const baseX = Math.cos(arch.angle) * arch.r;
      const baseY = Math.sin(arch.angle) * arch.r;
      for (let k = 0; k < cluster; k++) {
        // Pseudo-random but deterministic offsets in a disc around the cluster center.
        const seed = (i * 9301 + 49297) % 233280;
        const u = (seed / 233280);
        const seed2 = ((i + 7) * 1664525 + 1013904223) >>> 0;
        const v = (seed2 % 1000) / 1000;
        const a = u * Math.PI * 2;
        const r = Math.sqrt(v) * 38;
        arr.push({
          i,
          x: baseX + Math.cos(a) * r,
          y: baseY + Math.sin(a) * r,
          archetype: arch.id,
          hue: arch.hue,
          ai,
          delay: (i * 53) % 1600,
          // Each agent has a 'birth' threshold in 0..1 progress at which it activates.
          // Distribute non-uniformly so waves of activations happen.
          birth: Math.min(0.98, 0.05 + ((i * 7) % 100) / 100 * 0.9),
        });
        i++;
      }
    });
    return arr;
  }, [total]);

  const HUE = {
    pos: '#7dd49a',
    mid: '#b8b8c0',
    neg: '#f06c5a',
  };

  // Visible count comes from prop `count` (0..total).
  const activeCount = count;

  // Live mean sentiment based on streamingReplies received so far.
  const liveMean = React.useMemo(() => {
    if (!streamingReplies || streamingReplies.length === 0) return 0;
    const s = streamingReplies.reduce((a, r) => a + r.sentiment, 0);
    return s / streamingReplies.length;
  }, [streamingReplies]);

  return (
    <div style={{
      position: 'relative', height: H, borderRadius: 12,
      background: 'radial-gradient(circle at center, rgba(212,255,92,0.05) 0%, transparent 65%), var(--surface)',
      border: '1px solid var(--border)', overflow: 'hidden',
    }}>
      {/* SVG canvas — pannable viewBox centered on origin */}
      <svg width="100%" height="100%" viewBox={`${-W/2} ${-H/2} ${W} ${H}`} style={{ position: 'absolute', inset: 0 }}>
        {/* Concentric reference rings */}
        {[1, 2, 3].map((r) => (
          <circle key={r} cx={cx} cy={cy} r={r * 60}
            fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
        ))}
        {/* Slow rotating ripple */}
        {[1, 2].map((r) => (
          <circle key={`p${r}`} cx={cx} cy={cy} r={70 + r * 50}
            fill="none" stroke="rgba(212,255,92,0.10)" strokeWidth="1"
            style={{
              animationName: 'echo-ripple',
              animationDuration: `${3 + r * 0.4}s`,
              animationTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
              animationIterationCount: 'infinite',
              animationDelay: `${r * 0.5}s`,
              transformOrigin: 'center',
            }} />
        ))}

        {/* Edges: only render the most-recent ~6 reply edges. They originate
            at the agent and fade toward center, suggesting a reply traveling
            inward. */}
        {streamingReplies && streamingReplies.slice(-6).map((rep, idx) => {
          const a = agents[rep.i % agents.length];
          if (!a) return null;
          const age = (streamingReplies.length - 1 - (streamingReplies.length - 6 + idx));
          // older = more faded
          const opacity = Math.max(0.05, 0.45 - age * 0.06);
          const stroke = rep.sentiment > 0.15 ? HUE.pos : rep.sentiment < -0.15 ? HUE.neg : HUE.mid;
          return (
            <line key={`${rep.i}-${idx}`}
              x1={a.x} y1={a.y} x2={cx} y2={cy}
              stroke={stroke} strokeWidth="1" opacity={opacity}
              strokeDasharray="2 3"
            />
          );
        })}

        {/* Agents */}
        {agents.map((a) => {
          const visible = (a.i / total) <= (activeCount / total);
          const fill = visible ? HUE[a.hue] : '#2e2e34';
          const r = visible ? 2.4 : 1.8;
          const op = visible ? 0.95 : 0.35;
          return (
            <circle key={a.i} cx={a.x} cy={a.y} r={r}
              fill={fill} opacity={op}
              style={{
                animationName: visible ? 'echo-pulse' : 'none',
                animationDuration: '1.6s',
                animationTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
                animationIterationCount: 'infinite',
                animationDelay: `${a.delay}ms`,
                transition: 'fill 200ms, opacity 200ms, r 200ms',
              }} />
          );
        })}

        {/* Center node — the draft itself */}
        <circle cx={cx} cy={cy} r="14"
          fill="rgba(11,11,12,0.9)" stroke="rgba(212,255,92,0.35)" strokeWidth="1" />
        <circle cx={cx} cy={cy} r="3" fill="#d4ff5c" opacity="0.9"
          style={{
            animationName: 'echo-pulse',
            animationDuration: '1.6s',
            animationTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
            animationIterationCount: 'infinite',
          }} />
      </svg>

      {/* Center counter — overlaid on the central node */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, calc(-50% + 60px))',
        textAlign: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 38, fontWeight: 500,
          color: 'var(--fg-1)', letterSpacing: '-0.02em', whiteSpace: 'nowrap', lineHeight: 1,
        }}>
          {activeCount}<span style={{ color: 'var(--fg-3)', fontSize: 16 }}> / {total}</span>
        </div>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
          textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 6,
        }}>
          Agents responded
        </div>
      </div>

      {/* Top-right: live sentiment needle */}
      <NeedleHUD value={liveMean} />

      {/* Top-left: archetype legend */}
      <ArchetypeLegend />

      {/* Bottom: streaming reply ticker */}
      <ReplyTicker replies={streamingReplies} />

      {/* Bottom progress bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: 2, background: 'var(--surface-3)', overflow: 'hidden',
      }}>
        <div style={{
          width: `${progress * 100}%`, height: '100%',
          background: 'var(--accent-200)', transition: 'width 200ms linear',
        }} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Live sentiment needle, top-right.
// ─────────────────────────────────────────────────────────────────────
const NeedleHUD = ({ value }) => {
  // value -1..+1
  const pct = ((Math.max(-1, Math.min(1, value)) + 1) / 2) * 100;
  const tone = value > 0.2 ? '#7dd49a' : value < -0.2 ? '#f06c5a' : '#b8b8c0';
  return (
    <div style={{
      position: 'absolute', top: 14, right: 14,
      background: 'rgba(11,11,12,0.65)',
      border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 12px', width: 180,
      backdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Live mean</span>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 13, color: tone, fontWeight: 500,
        }}>{(value >= 0 ? '+' : '') + value.toFixed(2)}</span>
      </div>
      <div style={{
        position: 'relative', height: 6, borderRadius: 999,
        background: 'linear-gradient(to right, #f06c5a 0%, #f06c5a 18%, #b8b8c0 38%, #b8b8c0 62%, #7dd49a 82%, #7dd49a 100%)',
        opacity: 0.8,
      }}>
        <div style={{
          position: 'absolute', top: -3, left: `${pct}%`,
          width: 2, height: 12, background: 'var(--fg-1)',
          transform: 'translateX(-1px)', transition: 'left 240ms var(--ease-out)',
        }} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Archetype legend — six clusters, color-coded.
// ─────────────────────────────────────────────────────────────────────
const ArchetypeLegend = () => {
  const items = [
    { label: 'Enthusiast', color: '#7dd49a' },
    { label: 'Skeptic', color: '#f06c5a' },
    { label: 'Curious / lurker', color: '#b8b8c0' },
  ];
  return (
    <div style={{
      position: 'absolute', top: 14, left: 14,
      display: 'flex', flexDirection: 'column', gap: 4,
      background: 'rgba(11,11,12,0.6)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '8px 10px',
      backdropFilter: 'blur(8px)',
    }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 2,
      }}>Audience</span>
      {items.map((it) => (
        <div key={it.label} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: it.color }} />
          {it.label}
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Reply ticker — shows the last reply that streamed in.
// ─────────────────────────────────────────────────────────────────────
const ReplyTicker = ({ replies }) => {
  const last = replies && replies.length > 0 ? replies[replies.length - 1] : null;
  if (!last) return null;
  const tone = last.sentiment > 0.15 ? '#7dd49a' : last.sentiment < -0.15 ? '#f06c5a' : '#b8b8c0';
  return (
    <div key={replies.length} style={{
      position: 'absolute', left: 14, right: 14, bottom: 14,
      background: 'rgba(11,11,12,0.7)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 12px',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      backdropFilter: 'blur(8px)',
      animation: 'echo-tickerin 360ms var(--ease-out)',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 999, background: tone,
        marginTop: 7, flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-1)' }}>{last.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{last.handle}</span>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: tone }}>
            {(last.sentiment >= 0 ? '+' : '') + last.sentiment.toFixed(2)}
          </span>
        </div>
        <div style={{
          fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.4, marginTop: 2,
          overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
        }}>{last.text}</div>
      </div>
    </div>
  );
};

window.SimulationCanvasPro = SimulationCanvasPro;
