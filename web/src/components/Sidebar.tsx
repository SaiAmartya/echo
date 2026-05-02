"use client";
import Link from "next/link";
import { EchoMark, Icon, type IconName } from "./ui/Primitives";

type SidebarKey = "compose" | "history" | "audience" | "flags" | "";

type Item = { id: SidebarKey; label: string; icon: IconName; href: string };

const items: Item[] = [
  { id: "compose",  label: "Compose",  icon: "plus",    href: "/compose" },
  { id: "history",  label: "History",  icon: "history", href: "/history" },
];

export function Sidebar({ active }: { active: SidebarKey }) {
  return (
    <aside
      style={{
        width: 220,
        background: "var(--bg-deep)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
        gap: 4,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 12 }}>
        <EchoMark size={22} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            fontSize: 16,
            letterSpacing: "-0.02em",
            color: "var(--fg-1)",
          }}
        >
          echo
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          marginBottom: 12,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontSize: 12,
          color: "var(--fg-3)",
        }}
      >
        <Icon name="search" size={13} />
        <span>Search</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>⌘K</span>
      </div>

      {items.map((it) => {
        const isActive = active === it.id;
        return (
          <Link
            key={it.id}
            href={it.href}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              border: "none",
              background: isActive ? "var(--surface-2)" : "transparent",
              color: isActive ? "var(--fg-1)" : "var(--fg-2)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "var(--font-sans)",
              textAlign: "left",
              textDecoration: "none",
              transition: "background 120ms",
            }}
          >
            <Icon name={it.icon} size={15} />
            {it.label}
          </Link>
        );
      })}

      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: 12,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          This month
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-1)" }}>
          14 / 25 simulations
        </div>
        <div style={{ height: 4, background: "var(--surface-3)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: "56%", height: "100%", background: "var(--accent-200)" }} />
        </div>
      </div>
    </aside>
  );
}

export type { SidebarKey };
