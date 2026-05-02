// Shared force-graph helpers for SwarmThread + SwarmMap. Pure functions, no
// React; extracted so SwarmThread.tsx stays under the 500-line guideline.

export type Archetype =
  | "skeptic" | "enthusiast" | "curious" | "practitioner" | "pedant" | "lurker";

export const CLUSTER_CENTERS: Record<Archetype, { x: number; y: number; color: string }> = {
  enthusiast:   { x: -90,  y: -55, color: "#7dd49a" },
  practitioner: { x:  10,  y: -75, color: "#9bc97f" },
  curious:      { x:  90,  y: -25, color: "#b8b8c0" },
  lurker:       { x:  90,  y:  55, color: "#b8b8c0" },
  pedant:       { x:  -5,  y:  85, color: "#e8b75a" },
  skeptic:      { x: -100, y:  35, color: "#f06c5a" },
};

export function toneColor(s: number): string {
  return s > 0.15 ? "#7dd49a" : s < -0.15 ? "#f06c5a" : "#b8b8c0";
}

// Round any svg coord to 2 decimals so SSR (Node V8) and hydration emit the
// same string. Some Math.cos/sin chains diverge at the 14th decimal place
// and trip React's hydration mismatch warning otherwise.
export function r2(n: number): string {
  return n.toFixed(2);
}

export function agentPoint(
  agentId: string,
  archetype: Archetype,
): { x: number; y: number; color: string } {
  const center = CLUSTER_CENTERS[archetype] || CLUSTER_CENTERS.lurker;
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  const a = ((h % 1000) / 1000) * Math.PI * 2;
  const r = 14 + (((h >> 10) % 1000) / 1000) * 22;
  return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, color: center.color };
}
