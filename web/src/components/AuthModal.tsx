"use client";
import type { CSSProperties } from "react";
import { Button } from "./ui/Primitives";

export function AuthModal({
  mode = "signin",
  onClose,
}: {
  mode?: "signin" | "signup";
  onClose?: () => void;
}) {
  const isSignup = mode === "signup";
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(7,7,8,0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          width: 380,
          background: "var(--surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: 16,
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
          position: "relative",
        }}
      >
        <span
          onClick={onClose}
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            width: 24,
            height: 24,
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-3)",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          ×
        </span>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "var(--accent-200)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0a0c00",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            e
          </div>
          <h2
            style={{
              margin: "8px 0 0 0",
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: "-0.02em",
              color: "var(--fg-1)",
            }}
          >
            {isSignup ? "Create your account" : "Welcome back"}
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "var(--fg-3)", lineHeight: 1.5 }}>
            {isSignup ? "Simulate public reactions before you post." : "Sign in to continue your simulations."}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SSOButton label="Continue with Google" icon="g" />
          <SSOButton label="Continue with X" icon="x" />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--fg-4)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            or
          </span>
          <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input type="email" placeholder="you@company.com" style={inputStyle} />
          <input type="password" placeholder="Password" style={inputStyle} />
          <Button variant="primary" style={{ width: "100%", justifyContent: "center", marginTop: 4 }}>
            {isSignup ? "Create account" : "Sign in"}
          </Button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--fg-3)" }}>
          <span style={{ cursor: "pointer" }}>{isSignup ? "Already have an account? Sign in" : "No account? Sign up"}</span>
          {!isSignup && <span style={{ cursor: "pointer" }}>Forgot?</span>}
        </div>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  outline: "none",
};

function SSOButton({ label, icon }: { label: string; icon: "g" | "x" }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        cursor: "pointer",
        fontSize: 13,
        color: "var(--fg-1)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          background: "var(--bg-deep)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--fg-2)",
        }}
      >
        {icon === "g" ? "G" : "𝕏"}
      </span>
      <span>{label}</span>
    </div>
  );
}
