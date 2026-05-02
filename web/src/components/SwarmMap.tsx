"use client";

// SwarmMap — ambient "room" force-graph (right column of SwarmThread).
// Visualizes 200 personas as dots in archetype clusters, with tone-colored
// edges between agents who replied to each other and ripple rings on
// dogpiled posts. Dimmed (opacity 0.78) since the thread column is the hero
// in the post-Q3 layout.
//
// Extracted from SwarmThread.tsx in R2 to keep that file under 500 lines.

import { agentPoint, CLUSTER_CENTERS, r2, toneColor, type Archetype } from "@/lib/swarm-graph";

type AudienceKind = "target" | "public";

export type SwarmMapAgent = {
  id: string;
  name: string;
  handle: string;
  archetype: Archetype;
  audience: AudienceKind;
};

export type SwarmMapPost = {
  id: string;
  agent: string;
};

export type SwarmMapEdge = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  sentiment: number;
};

export function SwarmMap({
  posts,
  edges,
  dogpileIds,
  running,
  agents,
}: {
  posts: SwarmMapPost[];
  edges: SwarmMapEdge[];
  dogpileIds: Set<string>;
  running: boolean;
  agents: SwarmMapAgent[];
}) {
  const VW = 360;
  const VH = 280;
  const activeAgents = new Set(posts.map((p) => p.agent));
  const agentMap = new Map<string, SwarmMapAgent>(agents.map((a) => [a.id, a]));
  const dogpilePositions = posts
    .filter((p) => dogpileIds.has(p.id))
    .map((p) => {
      const ag = agentMap.get(p.agent);
      return ag ? agentPoint(ag.id, ag.archetype) : null;
    })
    .filter((v): v is { x: number; y: number; color: string } => Boolean(v));

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflow: "hidden",
        opacity: 0.78,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>The room</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
          {activeAgents.size} / 200 engaged
        </span>
      </div>

      <div
        style={{
          flex: 1,
          position: "relative",
          background:
            "radial-gradient(circle at center, rgba(212,255,92,0.03) 0%, transparent 65%), var(--bg-deep)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          minHeight: 200,
        }}
      >
        <svg
          viewBox={`${-VW / 2} ${-VH / 2} ${VW} ${VH}`}
          width="100%"
          height="100%"
          style={{ position: "absolute", inset: 0 }}
        >
          {Object.entries(CLUSTER_CENTERS).map(([k, c]) => (
            <circle key={k} cx={r2(c.x)} cy={r2(c.y)} r={48} fill={c.color} opacity={0.04} />
          ))}

          {edges.map((e, i) => (
            <line
              key={i}
              x1={r2(e.from.x)}
              y1={r2(e.from.y)}
              x2={r2(e.to.x)}
              y2={r2(e.to.y)}
              stroke={toneColor(e.sentiment)}
              strokeWidth={0.5}
              opacity={0.32}
            />
          ))}

          {agents.map((a) => {
            const p = agentPoint(a.id, a.archetype);
            const active = activeAgents.has(a.id);
            return (
              <g key={a.id}>
                <circle
                  cx={r2(p.x)}
                  cy={r2(p.y)}
                  r={active ? 2.4 : 1.6}
                  fill={active ? p.color : "#2e2e34"}
                  opacity={active ? 0.85 : 0.4}
                  style={{
                    animationName: active && running ? "echo-pulse" : "none",
                    animationDuration: "1.6s",
                    animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
                    animationIterationCount: "infinite",
                  }}
                />
              </g>
            );
          })}

          {Array.from({ length: 80 }).map((_, idx) => {
            const angle = (idx / 80) * Math.PI * 2 + (idx % 5) * 0.13;
            const radius = 20 + (idx % 9) * 12;
            const x = Math.cos(angle) * radius * 1.3;
            const y = Math.sin(angle) * radius * 1.0;
            return <circle key={`f${idx}`} cx={r2(x)} cy={r2(y)} r={1} fill="#43434b" opacity={0.4} />;
          })}

          <circle cx="0" cy="0" r={6} fill="rgba(11,11,12,0.95)" stroke="var(--accent-200)" strokeWidth={1} />
          <circle
            cx="0"
            cy="0"
            r={2}
            fill="var(--accent-200)"
            style={{
              animationName: "echo-pulse",
              animationDuration: "1.6s",
              animationTimingFunction: "cubic-bezier(0.65, 0, 0.35, 1)",
              animationIterationCount: "infinite",
            }}
          />

          {dogpilePositions.map((p, i) => (
            <circle
              key={`dp${i}`}
              cx={r2(p.x)}
              cy={r2(p.y)}
              r={8}
              fill="none"
              stroke="var(--accent-200)"
              strokeWidth={0.8}
              opacity={0.6}
              style={{
                animationName: "echo-ripple",
                animationDuration: "2.4s",
                animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
                animationIterationCount: "infinite",
                animationDelay: `${(i * 0.3).toFixed(2)}s`,
                transformOrigin: `${r2(p.x)}px ${r2(p.y)}px`,
              }}
            />
          ))}
        </svg>

        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            display: "flex",
            gap: 10,
            alignItems: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--fg-3)",
            background: "rgba(7,7,8,0.55)",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#7dd49a" }} /> positive
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#f06c5a" }} /> skeptic
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              paddingLeft: 6,
              borderLeft: "1px solid var(--border)",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, border: "1px solid var(--accent-200)" }} /> your audience
          </span>
        </div>
      </div>
    </div>
  );
}
