// ReplyList & ReplyCard — predicted replies feed.

const ReplyCard = ({ reply }) => (
  <div style={{
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 14, display: 'flex', gap: 12,
    transition: 'background 120ms, border-color 120ms',
  }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.borderColor = 'var(--border-strong)' }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderColor = 'var(--border)' }}
  >
    <Avatar initials={reply.initials} size={32} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>{reply.name}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>{reply.handle}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>simulated</span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.45 }}>{reply.text}</div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
        <span style={{ color: reply.sentiment > 0 ? '#7dd49a' : reply.sentiment < 0 ? '#f06c5a' : 'var(--fg-3)' }}>
          {reply.sentiment >= 0 ? '+' : ''}{reply.sentiment.toFixed(2)} sentiment
        </span>
        <span>likely · {reply.likely}%</span>
        <span>archetype: {reply.archetype}</span>
      </div>
    </div>
  </div>
);

const ReplyList = ({ replies }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: 'var(--fg-1)' }}>Predicted replies</h3>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
        {replies.length} of 247 · by likelihood
      </span>
    </div>
    {replies.map((r, i) => <ReplyCard key={i} reply={r} />)}
  </div>
);

window.ReplyCard = ReplyCard;
window.ReplyList = ReplyList;
