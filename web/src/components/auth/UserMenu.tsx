"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "../ui/Primitives";
import { useAuth } from "./AuthProvider";
import { signOut } from "@/lib/firebase/auth";

function initialsOf(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "??";
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!user) {
    return (
      <button
        onClick={() => router.push("/signin")}
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "6px 12px",
          fontSize: 12,
          color: "var(--fg-1)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        Sign in
      </button>
    );
  }

  const initials = initialsOf(user.displayName, user.email);

  const onSignOut = async () => {
    setOpen(false);
    await signOut();
    router.replace("/signin");
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span onClick={() => setOpen((v) => !v)} style={{ cursor: "pointer", display: "inline-flex" }}>
        <Avatar initials={initials} size={28} />
      </span>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 200,
            background: "var(--surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            padding: 6,
            zIndex: 40,
            boxShadow: "0 12px 32px -10px rgba(0,0,0,0.5)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div style={{ padding: "8px 10px 6px 10px", fontSize: 12, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email ?? user.displayName ?? "Signed in"}
          </div>
          <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />
          <button
            onClick={onSignOut}
            style={{
              textAlign: "left",
              padding: "8px 10px",
              background: "transparent",
              border: "none",
              color: "var(--fg-1)",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "var(--font-sans)",
              borderRadius: 6,
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
