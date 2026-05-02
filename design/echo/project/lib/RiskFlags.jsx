// RiskFlags — ratio risk callouts.

const RiskFlags = ({ flags }) => {
  if (!flags || flags.length === 0) return null;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid rgba(232,183,90,0.2)',
      borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="alert" size={15} style={{ color: '#e8b75a' }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>Risk flags</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', marginLeft: 'auto' }}>{flags.length} detected</span>
      </div>
      {flags.map((f, i) => (
        <div key={i} style={{
          padding: '10px 12px', background: 'rgba(232,183,90,0.06)',
          borderRadius: 8, fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.4,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#e8b75a', flexShrink: 0, paddingTop: 2 }}>{String(i+1).padStart(2,'0')}</span>
          <div>
            <div>{f.title}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{f.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

window.RiskFlags = RiskFlags;
