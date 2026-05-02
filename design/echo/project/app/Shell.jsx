// Shell — top nav and a few shared layout helpers used by the Echo screens.

const TopNav = ({ active = 'compose', audience = 'Notion · core' }) => (
  <div style={{
    height: 56, borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', padding: '0 24px', gap: 18,
    background: 'var(--bg)', flexShrink: 0,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <EchoMark size={20} />
      <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '-0.02em', color: 'var(--fg-1)' }}>echo</span>
    </div>
    <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
      {[
        { id: 'compose', label: 'New run' },
        { id: 'history', label: 'History' },
      ].map(it => (
        <button key={it.id} style={{
          padding: '6px 12px', border: 'none', background: active === it.id ? 'var(--surface-2)' : 'transparent',
          color: active === it.id ? 'var(--fg-1)' : 'var(--fg-2)',
          borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        }}>{it.label}</button>
      ))}
    </div>
    <div style={{ flex: 1 }} />
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 10px', borderRadius: 999, fontSize: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-2)',
    }}>
      <Icon name="users" size={12} />
      <span style={{ fontFamily: 'var(--font-mono)' }}>{audience}</span>
      <Icon name="chevronDown" size={11} style={{ opacity: 0.6 }} />
    </span>
    <Avatar initials="ED" size={28} />
  </div>
);

const Eyebrow = ({ children }) => (
  <span style={{
    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
    letterSpacing: '0.06em', textTransform: 'uppercase',
  }}>{children}</span>
);

// A faux X-style post preview, used inside Compose.
const PostPreview = ({ author = 'You', handle = '@you', text, avatarInitials = 'ED' }) => (
  <div style={{
    background: 'var(--bg-deep)', border: '1px solid var(--border)',
    borderRadius: 12, padding: 16, display: 'flex', gap: 12,
  }}>
    <Avatar initials={avatarInitials} size={36} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>{author}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>{handle}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>· now</span>
      </div>
      <div style={{ fontSize: 15, color: 'var(--fg-1)', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{text || <span style={{ color: 'var(--fg-3)' }}>Your draft will appear here.</span>}</div>
      <div style={{ display: 'flex', gap: 24, marginTop: 12, color: 'var(--fg-3)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
        <span>♡ —</span><span>↺ —</span><span>↩ —</span>
      </div>
    </div>
  </div>
);

const RatioRiskBig = ({ score = 64, tone = 'caution' }) => {
  const colors = { positive: '#7dd49a', caution: '#e8b75a', danger: '#f06c5a', neutral: '#b8b8c0' };
  const label = score < 25 ? 'Low' : score < 50 ? 'Mild' : score < 75 ? 'Elevated' : 'High';
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 24, display: 'flex', alignItems: 'center', gap: 24,
      backgroundImage: `radial-gradient(circle at 12% 50%, ${colors[tone]}10 0%, transparent 50%)`,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
        <Eyebrow>Ratio risk</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 64, fontWeight: 500,
            color: colors[tone], letterSpacing: '-0.04em', lineHeight: 1,
          }}>{score}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--fg-3)' }}>/100</span>
        </div>
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{label} risk · {score < 50 ? 'safe to ship' : 'consider rewriting'}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          height: 8, borderRadius: 999, position: 'relative',
          background: 'linear-gradient(to right, #7dd49a 0%, #7dd49a 25%, #e8b75a 50%, #f06c5a 100%)',
        }}>
          <div style={{
            position: 'absolute', top: -4, left: `${score}%`, width: 4, height: 16,
            background: 'var(--fg-1)', borderRadius: 2, transform: 'translateX(-2px)',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>
          <span>safe</span><span>mild</span><span>elevated</span><span>high</span>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { TopNav, Eyebrow, PostPreview, RatioRiskBig });
