"use client";
import { Button, Icon } from "./ui/Primitives";

export function Composer({
  draft,
  setDraft,
  audience,
  onRun,
  disabled,
}: {
  draft: string;
  setDraft: (v: string) => void;
  audience: string;
  onRun?: () => void;
  disabled?: boolean;
}) {
  const len = draft.length;
  const tooLong = len > 3500;
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Paste a draft here. We'll show you what happens before you publish."
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 17,
          lineHeight: 1.45,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--fg-1)",
          resize: "none",
          minHeight: 110,
          padding: 0,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingTop: 14,
          borderTop: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            padding: "6px 10px",
            borderRadius: 999,
            fontSize: 12,
            color: "var(--fg-2)",
            cursor: "pointer",
          }}
        >
          <Icon name="users" size={13} />
          {audience}
          <Icon name="chevronDown" size={12} style={{ opacity: 0.6 }} />
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: tooLong ? "#f06c5a" : "var(--fg-3)",
            marginLeft: "auto",
          }}
        >
          {len} / 3500
        </span>
        <Button variant="secondary">Save draft</Button>
        <Button
          variant="primary"
          icon={<Icon name="play" size={12} />}
          disabled={disabled || tooLong || len === 0}
          onClick={onRun}
        >
          Run simulation
        </Button>
      </div>
    </div>
  );
}
