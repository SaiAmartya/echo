// SentimentMeter — −1.0 to +1.0 readout with risk flags.

const SentimentMeter = ({ value = 0, replies = 0, flags = 0 }) => {
  const pct = ((value + 1) / 2) * 100;
  const tone = value > 0.2 ? 'positive' : value < -0.2 ? 'danger' : 'neutral';
  const colors = { positive: '#7dd49a', neutral: '#b8b8c0', danger: '#f06c5a' };
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Predicted reception</span>
        <Badge tone={tone === 'positive' ? 'positive' : tone === 'danger' ? 'danger' : 'neutral'} dot>
          {tone === 'positive' ? 'Low risk' : tone === 'danger' ? 'High ratio risk' : 'Mixed'}
        </Badge>
      </div>
      <div style={{ position: 'relative', height: 10, borderRadius: 999,
        background: 'linear-gradient(to right, #f06c5a 0%, #f06c5a 18%, #b8b8c0 38%, #b8b8c0 62%, #7dd49a 82%, #7dd49a 100%)' }}>
        <div style={{
          position: 'absolute', top: -6, left: `${pct}%`, width: 4, height: 22,
          background: 'var(--fg-1)', borderRadius: 2, transform: 'translateX(-2px)',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
        <span>−1.0</span><span>−0.5</span><span>0</span><span>+0.5</span><span>+1.0</span>
      </div>
      <div style={{ display: 'flex', gap: 32, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <Stat num={(value >= 0 ? '+' : '') + value.toFixed(2)} label="Mean sentiment" color={colors[tone]} />
        <Stat num={String(replies)} label="Replies" />
        <Stat num={String(flags)} label="Risk flags" color={flags > 0 ? '#e8b75a' : undefined} />
      </div>
    </div>
  );
};

const Stat = ({ num, label, color }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 500, color: color || 'var(--fg-1)' }}>{num}</span>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
  </div>
);

window.SentimentMeter = SentimentMeter;
