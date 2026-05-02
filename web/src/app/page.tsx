"use client";
import Link from "next/link";
import { useState } from "react";
import { AmbientViz } from "@/components/AmbientViz";
import { AuthModal } from "@/components/AuthModal";
import { Button, EchoMark, Icon } from "@/components/ui/Primitives";

export default function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false);
  return (
    <div style={{ width: "100%", minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 56, padding: "0 32px", display: "flex", alignItems: "center", gap: 16, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <EchoMark size={22} />
          <span style={{ fontWeight: 500, fontSize: 16, letterSpacing: "-0.02em" }}>echo</span>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>private beta · v0.4</span>
        <Button variant="ghost" size="sm" onClick={() => setAuthOpen(true)}>Sign in</Button>
      </div>
      <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 32px", minHeight: "calc(100vh - 56px)" }}>
        <AmbientViz />
        <div style={{ position: "relative", maxWidth: 720, textAlign: "center", display: "flex", flexDirection: "column", gap: 24, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent-200)", letterSpacing: "0.08em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent-200)", animation: "echo-pulse 1.6s var(--ease-in-out) infinite" }} />
            Pre-flight check for social posts
          </span>
          <h1 style={{ margin: 0, fontSize: 56, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1.05, color: "var(--fg-1)" }}>
            Post like you&apos;ve{" "}
            <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>already seen</span>{" "}
            the replies.
          </h1>
          <p style={{ margin: 0, fontSize: 17, color: "var(--fg-2)", lineHeight: 1.5, maxWidth: 540 }}>
            Paste a draft. <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>200 agents</span>, seeded from your real audience, run a 60-second simulated thread. See the ratio before it happens.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <Link href="/compose?sample=1" style={{ textDecoration: "none" }}>
              <Button variant="primary" size="lg" icon={<Icon name="play" size={13} />}>Try a sample</Button>
            </Link>
            <Link href="/audience" style={{ textDecoration: "none" }}>
              <Button variant="secondary" size="lg">Start with your audience</Button>
            </Link>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
            <span><span style={{ color: "var(--fg-1)" }}>60s</span> per simulation</span>
            <span><span style={{ color: "var(--fg-1)" }}>200</span> agents per run</span>
            <span><span style={{ color: "var(--fg-1)" }}>1,400+</span> posts triaged this week</span>
          </div>
        </div>
      </div>
      {authOpen && <AuthModal mode="signin" onClose={() => setAuthOpen(false)} />}
    </div>
  );
}
