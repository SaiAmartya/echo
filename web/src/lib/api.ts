// API client for the Echo backend.
// Wire format: see /.team/CONTRACTS.md (LOCKED v1).
// All paths are routed through Next's /api/* rewrite -> FastAPI on :8000.

import { getCurrentIdToken } from "./firebase/auth";

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

// v4 §16 — simulation mode discriminator on /simulate/start.
// "hypothetical" omits audience_id; "business" requires it.
export type SimulationMode = "business" | "hypothetical";

export interface SimulateStartRequest {
  draft: string;
  mode: SimulationMode;
  audience_id?: string;
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
  // v6 §21 — engagement signal. Backend computes deterministically per
  // (sim_id, post_id, round); FE just renders. Defaults to 0 for backward
  // compat with v1-v5 replays where the algorithm wasn't yet enabled.
  like_count: number;
  reply_count: number;
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

// v2 §8 — GET /history
export type HistoryTone = "positive" | "caution" | "danger" | "neutral";

export interface HistoryItem {
  simulation_id: string;
  draft: string;
  rounds: number;
  post_count: number;
  tone: HistoryTone;
  mean_sentiment: number;
  created_at: string;
  has_analysis: boolean;
  mode: SimulationMode;
}

export interface HistoryResponse {
  items: HistoryItem[];
}

// v2 §9 — GET /simulate/replay
export interface ReplayResponse {
  simulation_id: string;
  draft: string;
  rounds: number;
  posts: ServerPost[];
  analysis: Analysis | null;
  created_at: string;
  mode: SimulationMode;
}

// v3 §12 — POST /report
export type ReportTone = "positive" | "caution" | "danger" | "neutral";
export type ReportVerdict = "ship" | "revise" | "rethink";
export type ReportSeverity = "low" | "medium" | "high";

export interface ReportArchetypeReception {
  archetype: Archetype;
  tone: ReportTone;
  summary: string;
  representative_quote: string;
}

export interface ReportRiskVector {
  label: string;
  severity: ReportSeverity;
  detail: string;
}

export interface ReportRewriteOption {
  label: string;
  text: string;
  rationale: string;
}

export interface Report {
  executive_summary: string;
  verdict: ReportVerdict;
  verdict_rationale: string;
  audience_reception: ReportArchetypeReception[];
  risk_vectors: ReportRiskVector[];
  rewrite_options: ReportRewriteOption[];
  comparable_discourse: string;
}

export interface ReportResponse {
  simulation_id: string;
  draft: string;
  audience_label: string;
  rounds: number;
  post_count: number;
  generated_at: string;
  model: string;
  report: Report;
  mode: SimulationMode;
}

export interface GenerateReportRequest {
  simulation_id: string;
  regenerate?: boolean;
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
    else if (res.status === 401) code = "auth_invalid";
    else if (res.status === 404) code = "not_found";
    else if (res.status === 409) code = "analysis_pending";
    else if (res.status === 502) code = "gemini_unavailable";
  }
  // Unauthenticated → bounce to sign-in. The route guards normally catch this
  // pre-flight, but a stale token (deleted user, revoked session) only surfaces
  // here at request time.
  if (res.status === 401 && typeof window !== "undefined") {
    if (!window.location.pathname.startsWith("/signin")) {
      window.location.replace("/signin");
    }
  }
  return new ApiError({ code, message, status: res.status });
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getCurrentIdToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(path, { method: "GET", headers: auth });
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

export async function simulateStreamUrl(simulationId: string): Promise<string> {
  const token = await getCurrentIdToken();
  const params = new URLSearchParams({ simulation_id: simulationId });
  if (token) params.set("token", token);
  return `/api/simulate/stream?${params.toString()}`;
}

export function analyze(simulationId: string): Promise<Analysis> {
  return getJson<Analysis>(
    `/api/analyze?simulation_id=${encodeURIComponent(simulationId)}`,
  );
}

export function getHistory(opts?: { limit?: number }): Promise<HistoryResponse> {
  const limit = opts?.limit;
  const qs = typeof limit === "number" ? `?limit=${encodeURIComponent(limit)}` : "";
  return getJson<HistoryResponse>(`/api/history${qs}`);
}

export function getReplay(simulationId: string): Promise<ReplayResponse> {
  return getJson<ReplayResponse>(
    `/api/simulate/replay?simulation_id=${encodeURIComponent(simulationId)}`,
  );
}

export function generateReport(
  req: GenerateReportRequest,
): Promise<ReportResponse> {
  const params = new URLSearchParams({ simulation_id: req.simulation_id });
  if (req.regenerate) params.set("regenerate", "true");
  return postJson<ReportResponse>(`/api/report?${params.toString()}`, {});
}

export const api = {
  seed,
  simulateStart,
  simulateStreamUrl,
  analyze,
  getHistory,
  getReplay,
  generateReport,
};
