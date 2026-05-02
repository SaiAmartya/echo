"use client";
import { useMemo } from "react";

export function AmbientViz() {
  const nodes = useMemo(() => {
    const arr: { x: number; y: number; d: number; lit: boolean }[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2 + (i % 5) * 0.3;
      const r = 70 + (i % 6) * 22;
      arr.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, d: (i * 71) % 2400, lit: i % 3 === 0 });
    }
    return arr;
  }, []);
  return (
    <svg viewBox="-220 -160 440 320" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      <defs>
        <radialGradient id="ambient-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#d4ff5c" stopOpacity="0.10" />
          <stop offset="60%" stopColor="#d4ff5c" stopOpacity="0.02" />
          <stop offset="100%" stopColor="#d4ff5c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="-220" y="-160" width="440" height="320" fill="url(#ambient-glow)" />
      {[1, 2, 3, 4].map((r) => (
        <circle key={r} cx="0" cy="0" r={r * 38} fill="none"
          stroke="rgba(212,255,92,0.10)" strokeWidth="1"
          style={{ animation: `echo-ripple ${3 + r * 0.6}s var(--ease-out) infinite`, animationDelay: `${r * 0.5}s`, transformOrigin: "center" }} />
      ))}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.lit ? 1.6 : 1.2}
          fill={n.lit ? "#d4ff5c" : "#43434b"} opacity={n.lit ? 0.7 : 0.35}
          style={{ animation: n.lit ? "echo-pulse 2.4s var(--ease-in-out) infinite" : "none", animationDelay: `${n.d}ms` }} />
      ))}
    </svg>
  );
}
