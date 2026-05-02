// Compose — the product's home base.

const Compose = ({ withVariants = false, draft, variants }) => {
  const d = draft ?? window.SAMPLE_DRAFT;
  const vs = variants ?? [d, "we're rethinking toggles. inline blocks first, with a migration path. early access next week."];
  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <TopNav active="compose" audience="Notion · core" />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ComposeLeft withVariants={withVariants} draft={d} variants={vs} />
        <ComposeRight />
      </div>
    </div>
  );
};

const ComposeLeft = ({ withVariants, draft, variants }) => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'auto' }}>
    <div style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Eyebrow>Draft</Eyebrow>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>What are you about to post?</h2>
      </div>
      {!withVariants ? (
        <DraftCard draft={draft} idx={0} total={1} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {variants.map((v, i) => <DraftCard key={i} draft={v} idx={i} total={variants.length} />)}
        </div>
      )}
      {!withVariants && (
        <button style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          border: '1px dashed var(--border-strong)', background: 'transparent',
          borderRadius: 8, color: 'var(--fg-2)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13,
        }}>
          <Icon name="plus" size={13} /> Add variant for head-to-head test
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-2)' }}>
          <Icon name="users" size={12} />
          <span style={{ fontFamily: 'var(--font-mono)' }}>Notion · core</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-4)' }}>· 8,420</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>~60s · 200 agents</span>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm">Save draft</Button>
        <Button variant="primary" icon={<Icon name="play" size={12} />}>{withVariants ? `Run all ${variants.length}` : 'Run simulation'}</Button>
      </div>
    </div>
  </div>
);

const DraftCard = ({ draft, idx, total }) => {
  const len = draft.length;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {total > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--fg-2)', letterSpacing: '0.06em' }}>{String.fromCharCode(65 + idx)}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)' }}>variant {idx + 1} of {total}</span>
          <div style={{ flex: 1 }} />
          <button style={{ background: 'transparent', border: 'none', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)' }}>remove</button>
        </div>
      )}
      <div style={{ fontSize: 16, color: 'var(--fg-1)', lineHeight: 1.45, minHeight: 60 }}>{draft}</div>
      <PostPreview text={draft} />
      <div style={{ display: 'flex', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <span>plain text · no media</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: len > 280 ? '#f06c5a' : 'var(--fg-3)' }}>{len} / 280</span>
      </div>
    </div>
  );
};

const ComposeRight = () => (
  <div style={{ width: 420, background: 'var(--bg-deep)', display: 'flex', flexDirection: 'column', padding: 28, gap: 16 }}>
    <Eyebrow>Simulation</Eyebrow>
    <div style={{ flex: 1, border: '1px dashed var(--border-strong)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, padding: 24, textAlign: 'center' }}>
      <EchoMark size={40} accent={false} />
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: 'var(--fg-1)' }}>Paste a draft to begin.</h3>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-3)', maxWidth: 280 }}>
        Once you hit run, this panel turns into a live network of 200 agents reacting in real time.
      </p>
      <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 14, color: 'var(--fg-4)', marginTop: 10 }}>
        the wait is part of the experience
      </span>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>Last run · 4 minutes ago</Eyebrow>
      <RunCard h={window.HISTORY[0]} />
    </div>
  </div>
);

Object.assign(window, { Compose });
