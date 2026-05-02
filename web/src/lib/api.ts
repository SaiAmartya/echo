// API client for the Echo backend.
// Wire format: see /.team/CONTRACTS.md (LOCKED v1).
// All paths are routed through Next's /api/* rewrite -> FastAPI on :8000.

export type Archetype =
  | "skeptic"
  | "enthusiast"
  | "curious"
  | "practitioner"
  | "pedant"
  | "lurker";

export type AudienceKind = "target" | "public";

export interface ArchetypeShare {
  id: Archetype;
  name: string;
  share: number;
}

export interface Audience {
  audience_id: string;
  name: string;
  size: number;
  archetypes: ArchetypeShare[];
}

export type SeedMode = "csv" | "oauth" | "sample";

export interface SeedRequest {
  mode: SeedMode;
  payload: string | null;
}

export interface SimulateStartRequest {
  draft: string;
  audience_id: string;
  rounds: number;
}

export interface SimulateStartResponse {
  simulation_id: string;
  rounds: number;
  status: "running";
}

export interface ServerAgent {
  id: string;
  name: string;
  handle: string;
  archetype: Archetype;
  audience: AudienceKind;
}

export interface ServerPost {
  id: string;
  parent: string;
  round: number;
  agent: ServerAgent;
  sentiment: number;
  text: string;
}

export interface RoundEvent {
  round: number;
  of: number;
  posts: ServerPost[];
}

export interface DoneEvent {
  simulation_id: string;
}

export interface StreamErrorEvent {
  message: string;
  code: string;
}

export interface SuggestedRewrite {
  original: string;
  rewrite: string;
}

export interface WorthReadingChain {
  label: string;
  color: string;
  tldr: string;
}

export interface Analysis {
  simulation_id: string;
  tldr: string;
  suggested_rewrite: SuggestedRewrite;
  worth_reading: WorthReadingChain[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(opts: { code: string; message: string; status: number }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
  }
}

interface ErrorBody {
  detail?: unknown;
  code?: unknown;
  message?: unknown;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = "internal_error";
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.code === "string") code = body.code;
    if (typeof body.detail === "string") message = body.detail;
    else if (typeof body.message === "string") message = body.message;
  } catch {
    // non-JSON body — fall through with defaults
  }
  // Map a few well-known statuses where the server didn't set a code
  if (code === "internal_error") {
    if (res.status === 400) code = "bad_request";
    else if (res.status === 401) code = "oauth_failed";
    else if (res.status === 404) code = "not_found";
    else if (res.status === 409) code = "analysis_pending";
  }
  return new ApiError({ code, message, status: res.status });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "GET" });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export function seed(body: SeedRequest): Promise<Audience> {
  return postJson<Audience>("/api/seed", body);
}

export function simulateStart(
  body: SimulateStartRequest,
): Promise<SimulateStartResponse> {
  return postJson<SimulateStartResponse>("/api/simulate/start", body);
}

export function simulateStreamUrl(simulationId: string): string {
  return `/api/simulate/stream?simulation_id=${encodeURIComponent(simulationId)}`;
}

export function analyze(simulationId: string): Promise<Analysis> {
  return getJson<Analysis>(
    `/api/analyze?simulation_id=${encodeURIComponent(simulationId)}`,
  );
}

export const api = {
  seed,
  simulateStart,
  simulateStreamUrl,
  analyze,
};
