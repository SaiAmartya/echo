"use client";
import type { CSSProperties, ReactNode, MouseEvent } from "react";

// ─────────────────────────────────────────────────────────────
// Button
// ─────────────────────────────────────────────────────────────
type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  children?: ReactNode;
  icon?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  style?: CSSProperties;
  type?: "button" | "submit" | "reset";
};

export function Button({
  variant = "primary",
  size = "md",
  children,
  icon,
  onClick,
  disabled,
  style,
  type = "button",
}: ButtonProps) {
  const base: CSSProperties = {
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    lineHeight: 1,
    borderRadius: 6,
    border: "1px solid transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    transition: "background 120ms var(--ease-out), border-color 120ms, transform 80ms",
    opacity: disabled ? 0.4 : 1,
  };
  const sizes: Record<string, CSSProperties> = {
    sm: { padding: "6px 10px", fontSize: 12 },
    md: { padding: "8px 14px", fontSize: 13 },
    lg: { padding: "11px 18px", fontSize: 14 },
    icon: { padding: 8 },
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: "var(--accent-200)", color: "#0a0c00" },
    secondary: { background: "var(--surface-2)", color: "var(--fg-1)", borderColor: "var(--border-strong)" },
    ghost: { background: "transparent", color: "var(--fg-2)" },
    danger: { background: "transparent", color: "#f06c5a", borderColor: "rgba(240,108,90,0.3)" },
  };
  return (
    <button
      type={type}
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      onMouseDown={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.97)";
      }}
      onMouseUp={(e) => ((e.currentTarget as HTMLButtonElement).style.transform = "scale(1)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.transform = "scale(1)")}
    >
      {icon}
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Badge
// ─────────────────────────────────────────────────────────────
type BadgeTone = "positive" | "neutral" | "caution" | "danger" | "accent" | "mono";

export function Badge({
  tone = "neutral",
  children,
  dot = false,
  pulse = false,
}: {
  tone?: BadgeTone;
  children?: ReactNode;
  dot?: boolean;
  pulse?: boolean;
}) {
  const tones: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
    positive: { bg: "#1a2620", fg: "#7dd49a", border: "rgba(125,212,154,0.2)" },
    neutral:  { bg: "#1a1a1d", fg: "#b8b8c0", border: "var(--border)" },
    caution:  { bg: "#2a2316", fg: "#e8b75a", border: "rgba(232,183,90,0.2)" },
    danger:   { bg: "#2a1815", fg: "#f06c5a", border: "rgba(240,108,90,0.2)" },
    accent:   { bg: "rgba(212,255,92,0.12)", fg: "#d4ff5c", border: "rgba(212,255,92,0.3)" },
    mono:     { bg: "var(--surface-2)", fg: "var(--fg-2)", border: "var(--border)" },
  };
  const t = tones[tone];
  const monoFont: CSSProperties = tone === "mono" ? { fontFamily: "var(--font-mono)" } : {};
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        ...monoFont,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: t.fg,
            animation: pulse ? "echo-pulse 1.6s var(--ease-in-out) infinite" : "none",
          }}
        />
      )}
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Avatar
// ─────────────────────────────────────────────────────────────
export function Avatar({ initials, size = 32 }: { initials: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: "var(--surface-3)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: size * 0.35,
        color: "var(--fg-2)",
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Icon — Lucide-style inline SVGs
// ─────────────────────────────────────────────────────────────
export type IconName =
  | "play" | "pause" | "users" | "replies" | "trendingUp" | "trendingDown"
  | "alert" | "check" | "x" | "search" | "plus" | "home" | "history"
  | "settings" | "command" | "chevronDown" | "arrowUpRight" | "bookmark"
  | "zap" | "sparkles" | "refresh";

export function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    width: size,
    height: size,
    style,
  };
  const paths: Record<IconName, ReactNode> = {
    play: <polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none" />,
    pause: (
      <g>
        <rect x="6" y="4" width="4" height="16" />
        <rect x="14" y="4" width="4" height="16" />
      </g>
    ),
    users: (
      <g>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 19c0-3 3-5 6-5s6 2 6 5" />
        <circle cx="17" cy="9" r="2" />
        <path d="M21 18c0-2-2-3-4-3" />
      </g>
    ),
    replies: (
      <g>
        <path d="M7 9h10M7 13h6" />
        <path d="M21 12a9 9 0 1 1-3.5-7.1L21 4v5h-5" />
      </g>
    ),
    trendingUp: (
      <g>
        <polyline points="3,17 9,11 13,15 21,7" />
        <polyline points="14,7 21,7 21,14" />
      </g>
    ),
    trendingDown: (
      <g>
        <polyline points="3,7 9,13 13,9 21,17" />
        <polyline points="14,17 21,17 21,10" />
      </g>
    ),
    alert: (
      <g>
        <path d="M12 3 22 20H2Z" />
        <path d="M12 10v4" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
      </g>
    ),
    check: (
      <g>
        <circle cx="12" cy="12" r="9" />
        <polyline points="8,12 11,15 16,9" />
      </g>
    ),
    x: (
      <g>
        <circle cx="12" cy="12" r="9" />
        <line x1="9" y1="9" x2="15" y2="15" />
        <line x1="15" y1="9" x2="9" y2="15" />
      </g>
    ),
    search: (
      <g>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3-3" />
      </g>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    home: (
      <g>
        <path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-4v-7H10v7H4a1 1 0 0 1-1-1z" />
      </g>
    ),
    history: (
      <g>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <polyline points="3,3 3,8 8,8" />
        <polyline points="12,7 12,12 15,14" />
      </g>
    ),
    settings: (
      <g>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </g>
    ),
    command: <path d="M9 6a3 3 0 1 0-3 3h3V6zm0 0v12m0-12h6m0 0v12m0-12a3 3 0 1 1 3 3h-3V6zm-6 12a3 3 0 1 0 3 3v-3H3zm12 0v3a3 3 0 1 0 3-3h-3z" />,
    chevronDown: <polyline points="6,9 12,15 18,9" />,
    arrowUpRight: (
      <g>
        <line x1="7" y1="17" x2="17" y2="7" />
        <polyline points="7,7 17,7 17,17" />
      </g>
    ),
    bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
    zap: <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />,
    sparkles: (
      <g>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      </g>
    ),
    refresh: (
      <g>
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <polyline points="21,4 21,9 16,9" />
      </g>
    ),
  };
  return <svg {...props}>{paths[name] ?? null}</svg>;
}

// ─────────────────────────────────────────────────────────────
// EchoMark
// ─────────────────────────────────────────────────────────────
export function EchoMark({ size = 24, accent = true }: { size?: number; accent?: boolean }) {
  const color = accent ? "#d4ff5c" : "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <circle cx="11" cy="16" r="2.5" fill={color} />
      <path d="M16 10.5 A 6 6 0 0 1 16 21.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M20.5 7.5 A 10.5 10.5 0 0 1 20.5 24.5" stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      <path d="M25 4.5 A 15 15 0 0 1 25 27.5" stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.25" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Eyebrow
// ─────────────────────────────────────────────────────────────
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--fg-3)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}
