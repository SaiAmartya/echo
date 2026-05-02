// HistoryList — past simulations.

const HISTORY = [
  { draft: "we're done with quarterly OKRs. shipping monthly.", sentiment: 0.34, replies: 247, flags: 2, when: '2 hours ago', tone: 'caution' },
  { draft: "hot take: most design systems are just CSS reset packages with extra steps.", sentiment: -0.18, replies: 412, flags: 5, when: 'yesterday', tone: 'danger' },
  { draft: "Echo just shipped: paste a draft, see the replies before you post.", sentiment: 0.62, replies: 189, flags: 0, when: '3 days ago', tone: 'positive' },
  { draft: "calling it now: the next decade of software is built around feedback loops, not features.", sentiment: 0.41, replies: 308, flags: 1, when: 'last week', tone: 'positive' },
];

const HistoryList = ({ onOpen }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {HISTORY.map((h, i) => (
      <div key={i}
        onClick={() => onOpen?.(h)}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 16, cursor: 'pointer',
          display: 'flex', flexDirection: 'column', gap: 12,
          transition: 'background 120ms, border-color 120ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.borderColor = 'var(--border-strong)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderColor = 'var(--border)' }}
      >
        <div style={{ fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.45 }}>{h.draft}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
          <Badge tone={h.tone} dot>
            {h.tone === 'positive' ? 'Low risk' : h.tone === 'caution' ? 'Mild ratio risk' : 'High ratio risk'}
          </Badge>
          <span style={{ color: h.sentiment >= 0 ? '#7dd49a' : '#f06c5a' }}>{h.sentiment >= 0 ? '+' : ''}{h.sentiment.toFixed(2)}</span>
          <span>{h.replies} replies</span>
          {h.flags > 0 && <span style={{ color: '#e8b75a' }}>{h.flags} flag{h.flags === 1 ? '' : 's'}</span>}
          <span style={{ marginLeft: 'auto' }}>{h.when}</span>
        </div>
      </div>
    ))}
  </div>
);

window.HistoryList = HistoryList;
