// History — full history page (filterable). Settings — lightweight account/audience mgmt.

const History = () => (
  <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
    <TopNav active="history" audience="Notion · core" />
    <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <Eyebrow>History</Eyebrow>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>47 runs · last 30 days</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>Filter:</span>
          <Badge tone="accent">Notion · core</Badge>
          <Badge tone="mono">All time</Badge>
        </div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>
          Past simulations.
        </h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {window.HISTORY.map((h, i) => {
            const colors = { positive: '#7dd49a', caution: '#e8b75a', danger: '#f06c5a' };
            return (
              <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer' }}>
                <div style={{ width: 4, alignSelf: 'stretch', background: colors[h.tone], borderRadius: 2 }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{h.draft}</span>
                  <div style={{ display: 'flex', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
                    <span>{h.audience}</span><span>·</span><span>{h.replies} replies</span>
                    {h.flags > 0 && <><span>·</span><span style={{ color: '#e8b75a' }}>{h.flags} flag{h.flags === 1 ? '' : 's'}</span></>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 110 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: colors[h.tone] }}>{h.sentiment >= 0 ? '+' : ''}{h.sentiment.toFixed(2)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{h.when}</span>
                </div>
                <Icon name="arrowUpRight" size={14} style={{ color: 'var(--fg-3)' }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  </div>
);

const Settings = () => (
  <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
    <TopNav active="compose" audience="Notion · core" />
    <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div>
          <Eyebrow>Settings</Eyebrow>
          <h1 style={{ margin: '6px 0 0', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>Account & audiences.</h1>
        </div>
        <Section title="Audiences">
          {[
            { name: 'Notion · core', size: '8,420 commenters', refreshed: 'refreshed 2 days ago', active: true },
            { name: 'Founders + ops', size: '1,210 commenters', refreshed: 'refreshed last week', active: false },
          ].map(a => (
            <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
              <Icon name="users" size={15} style={{ color: 'var(--fg-2)' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</span>
                  {a.active && <Badge tone="accent">active</Badge>}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{a.size} · {a.refreshed}</span>
              </div>
              <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={11} />}>Refresh</Button>
              <Button variant="ghost" size="sm">Delete</Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" icon={<Icon name="plus" size={11} />}>Add audience</Button>
        </Section>
        <Section title="Connections">
          <Row icon="users" label="X (Twitter)" sub="connected as @echo · read-only" right={<Badge tone="positive" dot>connected</Badge>} />
          <Row icon="settings" label="Webhook" sub="not configured" right={<Button variant="ghost" size="sm">Add</Button>} />
        </Section>
        <Section title="Account">
          <Row icon="users" label="Eden Diaz" sub="eden@notion.so · pro plan" right={<Button variant="ghost" size="sm">Manage</Button>} />
          <Row icon="settings" label="Email digests" sub="weekly summary of risky drafts" right={<Toggle on />} />
        </Section>
      </div>
    </div>
  </div>
);

const Section = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <Eyebrow>{title}</Eyebrow>
    {children}
  </div>
);

const Row = ({ icon, label, sub, right }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
    <Icon name={icon} size={15} style={{ color: 'var(--fg-2)' }} />
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>{sub}</span>
    </div>
    {right}
  </div>
);

const Toggle = ({ on }) => (
  <div style={{ width: 36, height: 20, borderRadius: 999, background: on ? 'var(--accent-200)' : 'var(--surface-3)', padding: 2, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start', transition: 'all 120ms' }}>
    <div style={{ width: 16, height: 16, borderRadius: 999, background: on ? '#0a0c00' : 'var(--fg-3)' }} />
  </div>
);

Object.assign(window, { History, Settings });
