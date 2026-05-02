// Results — main results view + variant comparison + agent interview modal.

const ReplyCard = ({ reply, onAsk }) => {
  const tone = reply.sentiment > 0.15 ? '#7dd49a' : reply.sentiment < -0.15 ? '#f06c5a' : 'var(--fg-3)';
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'flex', gap: 12 }}>
      <Avatar initials={reply.initials} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>{reply.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>{reply.handle}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-4)', marginLeft: 'auto', textTransform: 'uppercase', letterSpacing: '0.06em' }}>simulated</span>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{reply.text}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
          <span style={{ color: tone }}>{reply.sentiment >= 0 ? '+' : ''}{reply.sentiment.toFixed(2)}</span>
          <span>likely {reply.likely}%</span>
          <span>· {reply.archetype}</span>
          <button style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--fg-2)', fontFamily: 'var(--font-sans)', fontSize: 11, cursor: 'pointer' }}>
            Ask this agent <Icon name="arrowUpRight" size={10} />
          </button>
        </div>
      </div>
    </div>
  );
};

const SentimentDistribution = ({ counts = { pos: 92, mix: 88, neg: 67 } }) => {
  const total = counts.pos + counts.mix + counts.neg;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Eyebrow>Sentiment distribution</Eyebrow>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{total} replies</span>
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ width: `${(counts.pos/total)*100}%`, background: '#7dd49a' }} />
        <div style={{ width: `${(counts.mix/total)*100}%`, background: '#43434b' }} />
        <div style={{ width: `${(counts.neg/total)*100}%`, background: '#f06c5a' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
        <span><span style={{ color: '#7dd49a' }}>●</span> positive · {counts.pos}</span>
        <span><span style={{ color: '#b8b8c0' }}>●</span> mixed · {counts.mix}</span>
        <span><span style={{ color: '#f06c5a' }}>●</span> negative · {counts.neg}</span>
      </div>
    </div>
  );
};

const RewriteCard = () => (
  <div style={{ background: 'var(--surface)', border: '1px solid rgba(212,255,92,0.25)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14, position: 'relative', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', top: 0, right: 0, width: 200, height: 80, background: 'radial-gradient(circle at top right, rgba(212,255,92,0.10), transparent 70%)' }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      <span style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(212,255,92,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-200)' }}>
        <Icon name="zap" size={13} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>Critic agent suggests</span>
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-200)' }}>−46 ratio risk</span>
    </div>
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55, padding: 14, background: 'var(--bg-deep)', borderRadius: 8, border: '1px solid var(--border)' }}>
      we're rethinking toggles. inline blocks first, with a migration path for existing docs. early access next week — {'\u2192'}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--fg-2)' }}>
      <div style={{ display: 'flex', gap: 8 }}><span style={{ color: 'var(--accent-200)', fontFamily: 'var(--font-mono)' }}>+</span> Adds migration story (top concern)</div>
      <div style={{ display: 'flex', gap: 8 }}><span style={{ color: 'var(--accent-200)', fontFamily: 'var(--font-mono)' }}>+</span> Drops "you'll thank us" framing</div>
      <div style={{ display: 'flex', gap: 8 }}><span style={{ color: 'var(--accent-200)', fontFamily: 'var(--font-mono)' }}>+</span> Hooks an early-access promise</div>
    </div>
    <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <Button variant="primary" size="sm" icon={<Icon name="refresh" size={11} />}>Re-run with this</Button>
      <Button variant="ghost" size="sm">Copy</Button>
    </div>
  </div>
);

const Results = () => (
  <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
    <TopNav active="compose" audience="Notion · core" />
    <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <Eyebrow>Result · 12 seconds ago</Eyebrow>
          <Badge tone="caution" dot>Elevated ratio risk</Badge>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" icon={<Icon name="bookmark" size={11} />}>Save run</Button>
          <Button variant="ghost" size="sm">Edit draft</Button>
        </div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, fontSize: 16, color: 'var(--fg-1)', lineHeight: 1.45 }}>
          {window.SAMPLE_DRAFT}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <RatioRiskBig score={64} tone="caution" />
            <SentimentDistribution />
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>Predicted top replies</h3>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>5 of 247 · by likelihood</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {window.SAMPLE_REPLIES.slice(0, 5).map((r, i) => <ReplyCard key={i} reply={r} />)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 0 }}>
            <RewriteCard />
            <div style={{ background: 'var(--surface)', border: '1px solid rgba(232,183,90,0.2)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="alert" size={14} style={{ color: '#e8b75a' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>Risk flags</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>2 detected</span>
              </div>
              {window.SAMPLE_FLAGS.map((f, i) => (
                <div key={i} style={{ background: 'rgba(232,183,90,0.06)', borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.45, display: 'flex', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#e8b75a' }}>{String(i+1).padStart(2,'0')}</span>
                  <div>
                    <div style={{ color: 'var(--fg-1)' }}>{f.title}</div>
                    <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>{f.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// Variant comparison results — leaderboard + collapsible inline detail.
const VariantResults = () => {
  const sorted = [...window.VARIANT_RESULTS].sort((a, b) => a.ratioRisk - b.ratioRisk);
  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <TopNav active="compose" audience="Notion · core" />
      <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <Eyebrow>Variant comparison · 18 seconds ago</Eyebrow>
            <Badge tone="positive" dot>4 variants ranked</Badge>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm">Edit drafts</Button>
            <Button variant="primary" size="sm">Publish winner</Button>
          </div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 500, letterSpacing: '-0.02em' }}>
            Variant B wins. <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontWeight: 400, color: 'var(--fg-2)' }}>By a comfortable margin.</span>
          </h2>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px 110px 110px 80px', padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              {['#', 'Draft', 'Ratio risk', 'Sentiment', 'Replies', 'Flags'].map((h, i) => (
                <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: i >= 2 && i <= 4 ? 'right' : 'left' }}>{h}</span>
              ))}
            </div>
            {sorted.map((v, i) => {
              const tone = v.tone === 'positive' ? '#7dd49a' : v.tone === 'caution' ? '#e8b75a' : '#f06c5a';
              return (
                <div key={v.id} style={{
                  display: 'grid', gridTemplateColumns: '40px 1fr 110px 110px 110px 80px',
                  padding: '14px 16px', borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none',
                  alignItems: 'center', background: i === 0 ? 'rgba(212,255,92,0.04)' : 'transparent',
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: i === 0 ? 'var(--accent-200)' : 'var(--fg-3)' }}>{i === 0 ? '★' : i + 1}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 16 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>{v.label}</span>
                    <span style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.draft}</span>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: tone, textAlign: 'right' }}>{v.ratioRisk}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: tone, textAlign: 'right' }}>{v.sentiment >= 0 ? '+' : ''}{v.sentiment.toFixed(2)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-2)', textAlign: 'right' }}>{v.replies}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: v.flags > 0 ? '#e8b75a' : 'var(--fg-3)', textAlign: 'right' }}>{v.flags}</span>
                </div>
              );
            })}
          </div>
          {/* Expanded winner detail */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge tone="accent" dot>Winner · variant B</Badge>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>expanded</span>
              <div style={{ flex: 1 }} />
              <Icon name="chevronDown" size={14} style={{ color: 'var(--fg-3)', transform: 'rotate(180deg)' }} />
            </div>
            <div style={{ fontSize: 15, color: 'var(--fg-1)', lineHeight: 1.45 }}>{sorted[0].draft}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <SentimentDistribution counts={{ pos: 124, mix: 58, neg: 16 }} />
              <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
                <Eyebrow>Audience overlap</Eyebrow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                  {[
                    { l: 'PMs', v: 84, c: '#7dd49a' },
                    { l: 'Founders', v: 71, c: '#7dd49a' },
                    { l: 'Designers', v: 52, c: '#b8b8c0' },
                    { l: 'Critics', v: 23, c: '#f06c5a' },
                  ].map(b => (
                    <div key={b.l} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 80, fontSize: 12, color: 'var(--fg-2)' }}>{b.l}</span>
                      <div style={{ flex: 1, height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${b.v}%`, height: '100%', background: b.c }} />
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', width: 36, textAlign: 'right' }}>{b.v}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* Collapsed variant rows */}
          {sorted.slice(1).map(v => (
            <div key={v.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 7px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--fg-2)' }}>{v.label.split(' · ')[0]}</span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.draft}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: v.tone === 'positive' ? '#7dd49a' : v.tone === 'caution' ? '#e8b75a' : '#f06c5a' }}>risk {v.ratioRisk}</span>
              <Icon name="chevronDown" size={14} style={{ color: 'var(--fg-3)' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Agent interview modal — static persona profile with the reply.
const AgentInterview = () => {
  const persona = {
    name: 'audrey lin', handle: '@audrey_lin', initials: 'AL',
    bio: 'PM at a 200-person SaaS. writes about building trust through small product decisions. 4.2k followers. opinionated about toggles.',
    archetype: 'Skeptical PM', cluster: 'Notion · core / PMs',
    style: 'measured, slightly arch. uses lowercase. prefers questions over assertions.',
    activeHours: 'mostly 21:00–23:00 PT',
    follows: 14, lastSeen: '2026-04-29',
  };
  const reply = window.SAMPLE_REPLIES[0];
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Ghosted results behind */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.4, pointerEvents: 'none' }}>
        <Results />
      </div>
      {/* Scrim */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(7,7,8,0.6)', backdropFilter: 'blur(8px)' }} />
      {/* Modal */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: 560, maxHeight: '90%', background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 16,
        boxShadow: 'var(--shadow-3)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Eyebrow>Agent profile</Eyebrow>
          <Badge tone="mono">simulated</Badge>
          <div style={{ flex: 1 }} />
          <button style={{ background: 'transparent', border: 'none', color: 'var(--fg-3)', cursor: 'pointer', padding: 4 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, overflow: 'auto' }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <Avatar initials={persona.initials} size={56} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 500 }}>{persona.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-3)' }}>{persona.handle}</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>{persona.bio}</p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['Archetype', persona.archetype],
              ['Cluster', persona.cluster],
              ['Posting style', persona.style],
              ['Active hours', persona.activeHours],
              ['Follows from your audience', `${persona.follows} of your top commenters`],
              ['Last seen', persona.lastSeen],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 12, background: 'var(--bg-deep)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <Eyebrow>{k}</Eyebrow>
                <span style={{ fontSize: 13, color: 'var(--fg-1)' }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Eyebrow>Their predicted reply</Eyebrow>
            <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.55 }}>
              {reply.text}
            </div>
            <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
              <span style={{ color: '#f06c5a' }}>{reply.sentiment >= 0 ? '+' : ''}{reply.sentiment.toFixed(2)} sentiment</span>
              <span>likely · {reply.likely}%</span>
              <span>archetype · {reply.archetype}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Eyebrow>Why this agent reacts this way</Eyebrow>
            <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.6 }}>
              <li>3 of her real past replies pushed back on prescriptive product changes.</li>
              <li>Her cluster (PMs) is over-indexed on "we know better" framings.</li>
              <li>Pre-empting with a migration story would shift this reply ~0.4 toward neutral.</li>
            </ul>
          </div>
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <Button variant="ghost" size="sm">View 3 similar agents</Button>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" size="sm">Close</Button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { Results, VariantResults, AgentInterview, ReplyCard, SentimentDistribution, RewriteCard });
