// SwarmThread — the core "agents react to each other" visualization.
// This is what makes Echo not-a-GPT-wrapper. We render a growing reply
// thread: the seed message at top, then agents post reactions, then those
// reactions grow their own sub-replies as the rounds advance. Edges show
// who-replied-to-whom; dogpiles (≥3 agents converging on one reply) get a
// soft halo. A round counter & sentiment trace sit alongside.
//
// The viz is split in two columns:
//   • Left: the live thread (post + nested replies, latest highlighted).
//   • Right: the swarm map (agents as dots, edges as reply-of links,
//     clusters tinted by sentiment, dogpiles ringed).
//
// Designed for 1280×800 artboards but is fluid.

// `audience` is 'target' (in the business's target audience) or 'public'
// (drawn from the general public). The whole point of Echo is that it
// simulates BOTH — the dogpile from someone outside your audience can
// blow up the post just as fast.
const SEED_AGENTS = [
  { id: 'a1',  name: 'audrey lin',  handle: '@audrey_lin',   archetype: 'skeptic',      audience: 'target' },
  { id: 'a2',  name: 'm. reid',     handle: '@mreid',        archetype: 'enthusiast',   audience: 'target' },
  { id: 'a3',  name: 'caleb',       handle: '@calebnotcaleb',archetype: 'curious',      audience: 'public' },
  { id: 'a4',  name: 'jules verne', handle: '@jverne',       archetype: 'enthusiast',   audience: 'target' },
  { id: 'a5',  name: 'tia k.',      handle: '@tiakwrites',   archetype: 'skeptic',      audience: 'public' },
  { id: 'a6',  name: 's. pham',     handle: '@sphamsf',      archetype: 'practitioner', audience: 'target' },
  { id: 'a7',  name: 'rohan k.',    handle: '@rohan',        archetype: 'curious',      audience: 'public' },
  { id: 'a8',  name: 'dani m.',     handle: '@dani_m',       archetype: 'pedant',       audience: 'public' },
  { id: 'a9',  name: 'priya s.',    handle: '@priya_s',      archetype: 'practitioner', audience: 'target' },
  { id: 'a10', name: 'oren f.',     handle: '@oren',         archetype: 'lurker',       audience: 'public' },
  { id: 'a11', name: 'sam c.',      handle: '@samc',         archetype: 'skeptic',      audience: 'public' },
  { id: 'a12', name: 'mei l.',      handle: '@meil',         archetype: 'enthusiast',   audience: 'target' },
];

// Scripted thread events — each event represents one agent posting at a
// specific round. parent = id of post they're replying to ('seed' = top).
// Sentiment in -1..+1.
const THREAD_SCRIPT = [
  { id: 'p1',  round: 1, parent: 'seed', agent: 'a2',  sentiment:  0.58, text: "finally. weekly memo > all-hands theatre." },
  { id: 'p2',  round: 1, parent: 'seed', agent: 'a1',  sentiment: -0.12, text: "monthly memos > quarterly OKRs but you'll still need a way to track outcomes. otherwise it's just velocity theater." },
  { id: 'p3',  round: 1, parent: 'seed', agent: 'a4',  sentiment:  0.42, text: "saved. doing this." },
  { id: 'p4',  round: 1, parent: 'seed', agent: 'a3',  sentiment:  0.04, text: "this works for product. how does it work for sales?" },

  { id: 'p5',  round: 2, parent: 'p1',   agent: 'a5',  sentiment: -0.34, text: "every team that says \"meetings are theatre\" replaces them with longer slack threads." },
  { id: 'p6',  round: 2, parent: 'p2',   agent: 'a8',  sentiment: -0.08, text: "agree. \"we'd rather ship\" reads as a vibe, not a system." },
  { id: 'p7',  round: 2, parent: 'p4',   agent: 'a9',  sentiment:  0.18, text: "we tried this in sales — pipeline reviews stayed live, everything else became a memo. worked." },
  { id: 'p8',  round: 2, parent: 'seed', agent: 'a6',  sentiment:  0.22, text: "what's the cycle length under the new model? weekly memo + monthly review?" },

  { id: 'p9',  round: 3, parent: 'p2',   agent: 'a11', sentiment: -0.28, text: "+1 to audrey. monthly is just shorter quarters with worse metrics." },
  { id: 'p10', round: 3, parent: 'p5',   agent: 'a8',  sentiment: -0.18, text: "this. the \"meetings = bad\" framing always undersells the actual cost: alignment debt." },
  { id: 'p11', round: 3, parent: 'p1',   agent: 'a12', sentiment:  0.52, text: "writing forces sharper thinking. zero notes." },
  { id: 'p12', round: 3, parent: 'p7',   agent: 'a3',  sentiment:  0.30, text: "interesting. did sales push back at first?" },

  { id: 'p13', round: 4, parent: 'p2',   agent: 'a5',  sentiment: -0.30, text: "thread of skeptics forming here — notion folks, are you reading?" },
  { id: 'p14', round: 4, parent: 'p2',   agent: 'a7',  sentiment: -0.05, text: "fwiw the absolutist phrasing (\"a tax on focus\") is the part that's drawing fire, not the idea." },
  { id: 'p15', round: 4, parent: 'p11',  agent: 'a4',  sentiment:  0.40, text: "memos > meetings is the boring right answer." },

  { id: 'p16', round: 5, parent: 'p2',   agent: 'a10', sentiment: -0.22, text: "ratio risk if you don't pre-empt the \"how do you measure\" replies." },
  { id: 'p17', round: 5, parent: 'p13',  agent: 'a1',  sentiment: -0.20, text: "consensus emerging: change the phrasing, keep the substance." },
];

// Cluster centers per archetype (in the swarm-map viewBox).
const CLUSTER_CENTERS = {
  enthusiast:   { x: -90,  y: -55, color: '#7dd49a' },
  practitioner: { x:  10,  y: -75, color: '#9bc97f' },
  curious:      { x:  90,  y: -25, color: '#b8b8c0' },
  lurker:       { x:  90,  y:  55, color: '#b8b8c0' },
  pedant:       { x:  -5,  y:  85, color: '#e8b75a' },
  skeptic:      { x: -100, y:  35, color: '#f06c5a' },
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
function getAgent(id) { return SEED_AGENTS.find((a) => a.id === id); }
function getInitials(name) { return name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase(); }
function toneColor(s) { return s > 0.15 ? '#7dd49a' : s < -0.15 ? '#f06c5a' : '#b8b8c0'; }

// Stable per-agent point inside its cluster (deterministic).
function agentPoint(agentId, archetype) {
  const center = CLUSTER_CENTERS[archetype] || CLUSTER_CENTERS.lurker;
  // Hash the agent id to reproducible offsets
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  const a = (h % 1000) / 1000 * Math.PI * 2;
  const r = 14 + ((h >> 10) % 1000) / 1000 * 22;
  return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, color: center.color };
}

// ────────────────────────────────────────────────────────────────
// SwarmThread — main component.
// Props:
//   currentRound (number, 0..maxRounds): how many rounds have completed
//   maxRounds (number)
//   seedDraft (string)
//   running (bool): show "live" badge & let a micro-pulse run
// ────────────────────────────────────────────────────────────────
const SwarmThread = ({ currentRound = 5, maxRounds = 5, seedDraft, running = false }) => {
  // Posts visible up to currentRound (rounds are 1-indexed; 0 = seed only)
  const posts = THREAD_SCRIPT.filter((p) => p.round <= currentRound);

  // Build reply-chain index → who-replied-to-what for the swarm-map edges
  const edges = posts.map((p) => {
    const ag = getAgent(p.agent);
    if (!ag) return null;
    const me = agentPoint(ag.id, ag.archetype);
    if (p.parent === 'seed') return { from: me, to: { x: 0, y: 0 }, sentiment: p.sentiment };
    const parent = posts.find((x) => x.id === p.parent);
    if (!parent) return null;
    const pAg = getAgent(parent.agent);
    if (!pAg) return null;
    const them = agentPoint(pAg.id, pAg.archetype);
    return { from: me, to: them, sentiment: p.sentiment };
  }).filter(Boolean);

  // Dogpiles: posts with ≥2 direct child replies in the visible set.
  const childCounts = {};
  posts.forEach((p) => { childCounts[p.parent] = (childCounts[p.parent] || 0) + 1; });
  const dogpileIds = new Set(Object.entries(childCounts).filter(([k, v]) => k !== 'seed' && v >= 2).map(([k]) => k));

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.05fr 1fr', gap: 16,
      height: '100%',
    }}>
      {/* LEFT — live thread */}
      <ThreadColumn
        seedDraft={seedDraft}
        posts={posts}
        running={running}
      />
      {/* RIGHT — swarm map */}
      <SwarmMap
        posts={posts}
        edges={edges}
        dogpileIds={dogpileIds}
        running={running}
      />
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// ThreadColumn — renders the seed + nested replies.
// We flatten visually but indent on `parent` to communicate hierarchy.
// ────────────────────────────────────────────────────────────────
const ThreadColumn = ({ seedDraft, posts, running }) => {
  // Compute depth per post (relative to seed)
  const depthOf = (p, memo = {}) => {
    if (memo[p.id] != null) return memo[p.id];
    if (p.parent === 'seed') return memo[p.id] = 0;
    const parent = posts.find((x) => x.id === p.parent);
    if (!parent) return memo[p.id] = 0;
    return memo[p.id] = depthOf(parent, memo) + 1;
  };
  const memo = {};
  const enriched = posts.map((p) => ({ ...p, depth: Math.min(depthOf(p, memo), 3) }));

  const lastRound = Math.max(...enriched.map((p) => p.round), 0);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 14, color: 'var(--fg-1)', fontWeight: 500 }}>The thread</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
          {posts.length} replies
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
        {/* Seed */}
        <div style={{
          background: 'var(--bg-deep)', border: '1px solid var(--border)',
          borderLeft: '2px solid var(--accent-200)',
          borderRadius: 10, padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-1)' }}>your post</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>@notion</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.45 }}>{seedDraft}</div>
        </div>

        {enriched.map((p) => {
          const ag = getAgent(p.agent);
          if (!ag) return null;
          const isLatest = p.round === lastRound;
          return (
            <div key={p.id} style={{
              marginLeft: p.depth * 18,
              borderLeft: p.depth > 0 ? '1px solid var(--border)' : 'none',
              paddingLeft: p.depth > 0 ? 10 : 0,
            }}>
              <div style={{
                background: isLatest ? 'var(--surface-2)' : 'transparent',
                border: '1px solid ' + (isLatest ? 'var(--border-strong)' : 'var(--border)'),
                borderRadius: 10, padding: '10px 12px',
                display: 'flex', gap: 10,
                transition: 'background 200ms',
              }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 999, flexShrink: 0,
                  background: 'var(--surface-3)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)',
                }}>{getInitials(ag.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-1)' }}>{ag.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{ag.handle}</span>
                    <span style={{
                      marginLeft: 'auto', width: 6, height: 6, borderRadius: 999,
                      background: toneColor(p.sentiment),
                    }} />
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.45, marginTop: 3 }}>{p.text}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// SwarmMap — agents as dots in clusters, edges = "replied to".
// ────────────────────────────────────────────────────────────────
const SwarmMap = ({ posts, edges, dogpileIds, running }) => {
  const VW = 360, VH = 280;
  const activeAgents = new Set(posts.map((p) => p.agent));
  const dogpilePositions = posts
    .filter((p) => dogpileIds.has(p.id))
    .map((p) => {
      const ag = getAgent(p.agent);
      return ag ? agentPoint(ag.id, ag.archetype) : null;
    })
    .filter(Boolean);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 14, color: 'var(--fg-1)', fontWeight: 500 }}>The room</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
          {activeAgents.size} / 200 engaged
        </span>
      </div>

      {/* The map */}
      <div style={{
        flex: 1, position: 'relative',
        background: 'radial-gradient(circle at center, rgba(212,255,92,0.04) 0%, transparent 65%), var(--bg-deep)',
        border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
        minHeight: 220,
      }}>
        <svg viewBox={`${-VW/2} ${-VH/2} ${VW} ${VH}`} width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
          {/* Cluster halos */}
          {Object.entries(CLUSTER_CENTERS).map(([k, c]) => (
            <circle key={k} cx={c.x} cy={c.y} r="48"
              fill={c.color} opacity="0.05" />
          ))}

          {/* Edges (reply-of links) */}
          {edges.map((e, i) => (
            <line key={i}
              x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}
              stroke={toneColor(e.sentiment)} strokeWidth="0.6" opacity="0.45" />
          ))}

          {/* All agents (background dots) */}
          {SEED_AGENTS.map((a) => {
            const p = agentPoint(a.id, a.archetype);
            const active = activeAgents.has(a.id);
            return (
              <g key={a.id}>
                <circle cx={p.x} cy={p.y}
                  r={active ? 3 : 2}
                  fill={active ? p.color : '#2e2e34'}
                  opacity={active ? 0.95 : 0.5}
                  style={{
                    animationName: active && running ? 'echo-pulse' : 'none',
                    animationDuration: '1.6s',
                    animationTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
                    animationIterationCount: 'infinite',
                  }}
                />
              </g>
            );
          })}

          {/* Filler agents — visualize the rest of the 200 */}
          {Array.from({ length: 80 }).map((_, idx) => {
            const angle = (idx / 80) * Math.PI * 2 + (idx % 5) * 0.13;
            const radius = 20 + (idx % 9) * 12;
            const x = Math.cos(angle) * radius * 1.3;
            const y = Math.sin(angle) * radius * 1.0;
            return (
              <circle key={`f${idx}`} cx={x} cy={y} r="1.2" fill="#43434b" opacity="0.55" />
            );
          })}

          {/* Seed at center */}
          <circle cx="0" cy="0" r="6" fill="rgba(11,11,12,0.95)" stroke="var(--accent-200)" strokeWidth="1" />
          <circle cx="0" cy="0" r="2" fill="var(--accent-200)"
            style={{
              animationName: 'echo-pulse',
              animationDuration: '1.6s',
              animationTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
              animationIterationCount: 'infinite',
            }} />

          {/* Dogpile rings */}
          {dogpilePositions.map((p, i) => (
            <circle key={`dp${i}`} cx={p.x} cy={p.y} r="9"
              fill="none" stroke="var(--accent-200)" strokeWidth="1" opacity="0.7"
              style={{
                animationName: 'echo-ripple',
                animationDuration: '2.4s',
                animationTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
                animationIterationCount: 'infinite',
                animationDelay: `${i * 0.3}s`,
                transformOrigin: `${p.x}px ${p.y}px`,
              }} />
          ))}
        </svg>

        {/* Legend overlay */}
        <div style={{
          position: 'absolute', bottom: 8, left: 8,
          display: 'flex', gap: 10, alignItems: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
          background: 'rgba(7,7,8,0.55)', padding: '4px 8px', borderRadius: 6,
          border: '1px solid var(--border)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: '#7dd49a' }} /> positive
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: '#f06c5a' }} /> skeptic
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, paddingLeft: 6, borderLeft: '1px solid var(--border)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, border: '1px solid var(--accent-200)' }} /> your audience
          </span>
        </div>
      </div>

    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// RoundTrace — sentiment over rounds, with dots per round.
// ────────────────────────────────────────────────────────────────
const RoundTrace = ({ trace, currentRound, maxRounds }) => {
  const W = 320, H = 50;
  const points = trace.map((v, i) => {
    if (v == null) return null;
    const x = (i / Math.max(1, maxRounds - 1)) * W;
    const y = H / 2 - v * (H / 2 - 4);
    return { x, y, v };
  });
  const filled = points.filter(Boolean);
  const path = filled.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  return (
    <div style={{
      background: 'var(--bg-deep)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Sentiment per round</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-2)' }}>
          mean: {filled.length ? ((filled[filled.length - 1].v >= 0 ? '+' : '') + filled[filled.length - 1].v.toFixed(2)) : '—'}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        {/* zero line */}
        <line x1="0" y1={H/2} x2={W} y2={H/2} stroke="var(--border)" strokeDasharray="2 3" />
        {/* path */}
        <path d={path} fill="none" stroke="var(--accent-200)" strokeWidth="1.5" />
        {/* dots */}
        {points.map((p, i) => p && (
          <circle key={i} cx={p.x} cy={p.y} r={i === currentRound - 1 ? 3 : 2}
            fill={i === currentRound - 1 ? 'var(--accent-200)' : 'var(--fg-3)'} />
        ))}
        {/* round ticks */}
        {Array.from({ length: maxRounds }).map((_, i) => (
          <line key={i} x1={(i / Math.max(1, maxRounds - 1)) * W} y1={H - 4} x2={(i / Math.max(1, maxRounds - 1)) * W} y2={H} stroke="var(--fg-4)" />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-4)' }}>
        {Array.from({ length: maxRounds }).map((_, i) => <span key={i}>R{i + 1}</span>)}
      </div>
    </div>
  );
};

Object.assign(window, { SwarmThread, SEED_AGENTS, THREAD_SCRIPT });
