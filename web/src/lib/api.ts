// Thin client for the Python FastAPI backend.
// The frontend hits /api/* which next.config.mjs rewrites to NEXT_PUBLIC_API_BASE.

export type SeedRequest = { mode: "csv" | "oauth" | "sample"; payload?: string };
export type SeedResponse = { audience_id: string; name: string; size: number; archetypes: { id: string; name: string; share: number }[] };

export type SimulateStartRequest = { draft: string; audience_id: string; rounds?: number };
export type SimulateStartResponse = { simulation_id: string; rounds: number; status: string };

export type AnalyzeResponse = {
  simulation_id: string;
  ratio_risk: number;
  tone: "positive" | "caution" | "danger" | "neutral";
  sentiment: { pos: number; mix: number; neg: number };
  rewrite: string;
  replies: { initials: string; name: string; handle: string; text: string; sentiment: number; likely: number; archetype: string }[];
  flags: { title: string; detail: string }[];
};

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  seed: (body: SeedRequest) => jsonFetch<SeedResponse>("/api/seed", { method: "POST", body: JSON.stringify(body) }),
  simulateStart: (body: SimulateStartRequest) => jsonFetch<SimulateStartResponse>("/api/simulate/start", { method: "POST", body: JSON.stringify(body) }),
  simulateStreamUrl: (simulationId: string) => `/api/simulate/stream?simulation_id=${encodeURIComponent(simulationId)}`,
  analyze: (simulationId: string) => jsonFetch<AnalyzeResponse>(`/api/analyze?simulation_id=${encodeURIComponent(simulationId)}`),
};
