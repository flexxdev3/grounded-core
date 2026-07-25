/**
 * @grounded/client — a thin, typed `fetch` wrapper over the Grounded REST API.
 *
 * Zero runtime dependencies: types come from `@grounded/core/contract` via
 * `import type` (elided at build), so nothing from core is loaded at runtime.
 */
import type {
  Fact,
  FactInput,
  Session,
  SessionInput,
  Doc,
  RecallResult,
  RecallOptions,
  BriefResult,
  BriefOptions,
  ListOptions,
  HealthReport,
  IngestOptions,
  IngestReport,
  FullRecord,
  TypedId,
  Vision,
  VisionInput,
} from "@grounded/core/contract";

export interface ClientOptions {
  /** Base URL of a running grounded-api, e.g. http://127.0.0.1:7437 */
  baseUrl: string;
  /** Bearer token, if the API has auth enabled. */
  token?: string;
  /** Override the fetch implementation (e.g. an in-process Hono app.fetch). */
  fetch?: typeof fetch;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

/** Thrown on a non-2xx response; carries the API's status + error code. */
export class GroundedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GroundedHttpError";
  }
}

export interface GroundedClient {
  health(): Promise<HealthReport>;
  /**
   * `opts.scopes` filters the doc lane (match any, OR); defaults to
   * `['global']` when omitted so callers that declare nothing never see
   * non-global lanes (e.g. "administration") in results.
   */
  recall(query: string, opts?: RecallOptions): Promise<RecallResult[]>;
  /**
   * `opts.docScopes` sets the explicit doc-lane scope set for the
   * related-docs recall call (defaults to `['global']` when omitted/empty).
   */
  brief(opts?: BriefOptions): Promise<BriefResult>;
  /** Fetch a full record by typed id, e.g. "fact:27" / "session:274" / "doc:1091". */
  get(typedId: TypedId): Promise<FullRecord>;
  vision: {
    /** Set the vision for a scope; edits the active record in place (one per scope). */
    set(input: VisionInput): Promise<Vision>;
    list(opts?: ListOptions): Promise<Vision[]>;
    delete(id: number): Promise<{ deleted: boolean; id: number }>;
  };
  facts: {
    add(input: FactInput): Promise<Fact>;
    list(opts?: ListOptions): Promise<Fact[]>;
    delete(id: number): Promise<{ deleted: boolean; id: number }>;
    /** Edit fact `id` in place (partial patch). */
    update(id: number, patch: Partial<FactInput>): Promise<Fact>;
  };
  sessions: {
    add(input: SessionInput): Promise<Session>;
    list(opts?: ListOptions): Promise<Session[]>;
    get(id: number): Promise<Session>;
  };
  docs: {
    /**
     * `opts.source` filters by logical source/collection (e.g. "homelab" |
     * "repo:grounded"). `opts.scope`/`opts.scopes` filter by lane instead —
     * distinct from `source`, unfiltered by default so the console can still
     * browse every lane.
     */
    list(opts?: ListOptions): Promise<Doc[]>;
    get(id: number): Promise<Doc>;
    /**
     * Ingest/re-ingest files or directories; returns the change report.
     * `opts.scope` tags every chunk in this batch with a lane (default
     * `"global"`); `opts.machine` and `opts.kind` are forwarded as-is.
     */
    ingest(paths: string[], opts?: IngestOptions): Promise<IngestReport>;
    /**
     * Reconcile docs rows against disk: files under a previously-ingested
     * path that no longer exist are marked `status: "missing"`, or deleted
     * outright when `remove: true`. `IngestReport.removed` is a different,
     * unrelated counter — this is the disk-reconciliation signal.
     */
    prune(opts?: { remove?: boolean }): Promise<{ missing: number; removed: number }>;
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function createClient(options: ClientOptions): GroundedClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const baseHeaders: Record<string, string> = { ...options.headers };
  if (options.token) baseHeaders.authorization = `Bearer ${options.token}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...baseHeaders };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await doFetch(`${base}${path}`, { method, headers, body: payload });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; code?: string };
      throw new GroundedHttpError(res.status, err.code ?? "HTTP_ERROR", err.error ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  return {
    health: () => request<HealthReport>("GET", "/health"),
    recall: (query, opts = {}) => request<RecallResult[]>("POST", "/recall", { query, ...opts }),
    brief: (opts = {}) => request<BriefResult>("POST", "/brief", opts),
    get: (typedId) => request<FullRecord>("GET", `/get/${typedId}`),
    vision: {
      set: (input) => request<Vision>("POST", "/vision", input),
      list: (opts = {}) =>
        request<Vision[]>(
          "GET",
          `/vision${qs({ scope: opts.scope, limit: opts.limit, offset: opts.offset })}`,
        ),
      delete: (id) => request<{ deleted: boolean; id: number }>("DELETE", `/vision/${id}`),
    },
    facts: {
      add: (input) => request<Fact>("POST", "/facts", input),
      list: (opts = {}) =>
        request<Fact[]>(
          "GET",
          `/facts${qs({
            scope: opts.scope,
            scopes: opts.scopes?.length ? opts.scopes.join(",") : undefined,
            status: opts.status,
            limit: opts.limit,
            offset: opts.offset,
          })}`,
        ),
      delete: (id) => request<{ deleted: boolean; id: number }>("DELETE", `/facts/${id}`),
      update: (id, patch) => request<Fact>("PATCH", `/facts/${id}`, patch),
    },
    sessions: {
      add: (input) => request<Session>("POST", "/sessions", input),
      list: (opts = {}) =>
        request<Session[]>("GET", `/sessions${qs({ project: opts.project, limit: opts.limit })}`),
      get: (id) => request<Session>("GET", `/sessions/${id}`),
    },
    docs: {
      list: (opts = {}) =>
        request<Doc[]>(
          "GET",
          `/docs${qs({
            source: opts.source,
            scope: opts.scope,
            scopes: opts.scopes?.length ? opts.scopes.join(",") : undefined,
            limit: opts.limit,
            offset: opts.offset,
            documents: opts.documents ? "true" : undefined,
          })}`,
        ),
      get: (id) => request<Doc>("GET", `/docs/${id}`),
      ingest: (paths, opts = {}) => request<IngestReport>("POST", "/docs/ingest", { paths, ...opts }),
      prune: (opts = {}) =>
        request<{ missing: number; removed: number }>("POST", "/docs/prune", opts),
    },
  };
}
