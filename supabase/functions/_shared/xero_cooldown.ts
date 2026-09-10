// Shared transport maintenance only. Never stores credentials or ledger data.
export interface XeroCooldownScope {
  orgId: string;
  appKey: string;
  tenantId: string;
}

export interface XeroCooldownState {
  version: 1;
  revision: string;
  blocked_until: string | null;
  observation: Record<string, unknown> | null;
  probe: { owner: string; until: string } | null;
}

export interface XeroCooldownStore {
  read(scope: XeroCooldownScope): Promise<XeroCooldownState | null>;
  compareAndSwap(
    scope: XeroCooldownScope,
    expectedRevision: string | null,
    next: XeroCooldownState,
  ): Promise<boolean>;
}

export class XeroCooldownError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "XeroCooldownError";
  }
}

const REPORTS = new WeakMap<Response, Record<string, unknown>>();
const API_FAMILIES = new WeakMap<Response, "accounting" | "projects">();
export function xeroCooldownReport(response: Response) {
  return REPORTS.get(response) ?? null;
}

export async function xeroAppKey(clientId: string): Promise<string> {
  if (!clientId) throw unavailable();
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(clientId),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function key(scope: XeroCooldownScope) {
  return `integration.xero.cooldown.v1:${scope.appKey}:${scope.tenantId}`;
}

function unavailable() {
  return new XeroCooldownError(
    "Shared Xero cooldown protection is unavailable; no provider request was sent",
    503,
    "XERO_GUARD_UNAVAILABLE",
    { provider_called: false, provider_call_made: false, shared_guard: false },
  );
}

function validState(value: unknown): value is XeroCooldownState {
  if (!value || typeof value !== "object") return false;
  const state = value as XeroCooldownState;
  return state.version === 1 && typeof state.revision === "string" &&
    !!state.revision &&
    (state.blocked_until === null ||
      (typeof state.blocked_until === "string" &&
        Number.isFinite(Date.parse(state.blocked_until)))) &&
    (state.probe === null ||
      (typeof state.probe?.owner === "string" &&
        typeof state.probe.until === "string" &&
        Number.isFinite(Date.parse(state.probe.until))));
}

// PostgREST compares the revision in the SAME UPDATE that replaces the value.
// Insert collisions lose; neither path can overwrite a concurrent winner.
export function createOrgConfigXeroCooldownStore(
  // deno-lint-ignore no-explicit-any
  client: any,
): XeroCooldownStore {
  return {
    async read(scope) {
      const { data, error } = await client.from("org_config").select(
        "config_value",
      )
        .eq("org_id", scope.orgId).eq("config_key", key(scope))
        .abortSignal(AbortSignal.timeout(2_000)).maybeSingle();
      if (error) throw unavailable();
      if (!data) return null;
      if (!validState(data.config_value)) throw unavailable();
      return data.config_value;
    },
    async compareAndSwap(scope, expectedRevision, next) {
      const row = {
        org_id: scope.orgId,
        config_key: key(scope),
        config_value: next,
        updated_at: new Date().toISOString(),
      };
      const query = expectedRevision === null
        ? client.from("org_config").insert(row)
        : client.from("org_config").update({
          config_value: next,
          updated_at: row.updated_at,
        })
          .eq("org_id", scope.orgId).eq("config_key", key(scope)).eq(
            "config_value->>revision",
            expectedRevision,
          );
      const { data, error } = await query.select("config_value").abortSignal(
        AbortSignal.timeout(2_000),
      ).maybeSingle();
      if (error?.code === "23505" && expectedRevision === null) return false;
      if (error) throw unavailable();
      return !!data;
    },
  };
}

export function xeroRateLimitDetails(
  response: Response,
  now: Date = new Date(),
) {
  const raw = response.headers.get("Retry-After");
  const date = raw ? Date.parse(raw) : NaN;
  const seconds = raw && /^\d+$/.test(raw)
    ? Number(raw)
    : Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now.getTime()) / 1000))
    : null;
  const ms = seconds === null ? NaN : now.getTime() + seconds * 1000;
  const valid = seconds !== null && Number.isSafeInteger(seconds) &&
    Number.isFinite(new Date(ms).getTime());
  const header = (name: string) =>
    response.headers.get(name)?.slice(0, 256) ?? null;
  return {
    provider_status: response.status,
    provider_api: API_FAMILIES.get(response) ?? null,
    retry_after_seconds: valid ? seconds : null,
    retry_at: valid ? new Date(ms).toISOString() : null,
    observed_at: now.toISOString(),
    request_id: header("xero-correlation-id") ?? header("xero-request-id") ??
      header("x-request-id"),
    quota: {
      minute_remaining: header("x-minlimit-remaining"),
      day_remaining: header("x-daylimit-remaining"),
      app_minute_remaining: header("x-appminlimit-remaining"),
      limit_problem: header("x-rate-limit-problem"),
    },
  };
}

export function xeroRateLimitError(response: Response) {
  void response.body?.cancel().catch(() => {});
  return new XeroCooldownError(
    "Xero rate limited; wait until retry_at before another request",
    429,
    "XERO_RATE_LIMITED",
    {
      ...xeroRateLimitDetails(response),
      provider_called: true,
      provider_call_made: true,
      shared_cooldown: xeroCooldownReport(response),
    },
  );
}

export function createXeroCooldownGuard(
  store: XeroCooldownStore,
  options: { now?: () => Date; uuid?: () => string; probeLeaseMs?: number } =
    {},
) {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const fresh = (): XeroCooldownState => ({
    version: 1,
    revision: uuid(),
    blocked_until: null,
    observation: null,
    probe: null,
  });
  const load = async (scope: XeroCooldownScope) => {
    try {
      const state = await store.read(scope);
      if (state !== null && !validState(state)) throw unavailable();
      return state;
    } catch {
      throw unavailable();
    }
  };
  const cas = async (
    scope: XeroCooldownScope,
    previous: XeroCooldownState | null,
    next: XeroCooldownState,
  ) => {
    try {
      return await store.compareAndSwap(
        scope,
        previous?.revision ?? null,
        next,
      );
    } catch {
      throw unavailable();
    }
  };
  return {
    async beforeRequest(scope: XeroCooldownScope): Promise<string | null> {
      const budgetEnds = performance.now() + 3_000;
      for (
        let attempt = 0;
        attempt < 4 && performance.now() < budgetEnds;
        attempt++
      ) {
        const state = await load(scope);
        if (!state?.blocked_until) return null;
        const clock = now().getTime();
        const blockedUntil = Date.parse(state.blocked_until);
        if (blockedUntil > clock) {
          throw new XeroCooldownError(
            "Xero shared cooldown is active; no provider request was sent",
            429,
            "XERO_COOLDOWN_ACTIVE",
            {
              retry_at: state.blocked_until,
              retry_after_seconds: Math.ceil((blockedUntil - clock) / 1000),
              provider_called: false,
              provider_call_made: false,
              shared_guard: true,
              tenant_id: scope.tenantId,
              last_rate_limit: state.observation,
            },
          );
        }
        if (state.probe && Date.parse(state.probe.until) > clock) {
          throw new XeroCooldownError(
            "Another request is checking Xero after the cooldown",
            429,
            "XERO_PROBE_IN_PROGRESS",
            {
              retry_at: state.probe.until,
              provider_called: false,
              provider_call_made: false,
              shared_guard: true,
              tenant_id: scope.tenantId,
            },
          );
        }
        const owner = uuid();
        const next = {
          ...state,
          revision: uuid(),
          probe: {
            owner,
            until: new Date(clock + (options.probeLeaseMs ?? 45_000))
              .toISOString(),
          },
        };
        if (await cas(scope, state, next)) return owner;
      }
      throw unavailable();
    },
    async afterResponse(
      scope: XeroCooldownScope,
      owner: string | null,
      response: Response | null,
    ) {
      if (response?.status !== 429 && !owner) return;
      const observation = response?.status === 429
        ? xeroRateLimitDetails(response, now())
        : null;
      const budgetEnds = performance.now() + 3_000;
      for (
        let attempt = 0;
        attempt < 4 && performance.now() < budgetEnds;
        attempt++
      ) {
        const state = await load(scope);
        const next = { ...(state ?? fresh()), revision: uuid() };
        if (observation) {
          // Missing/invalid Retry-After gets an explicitly labelled local 60s
          // fallback. No claim about the provider's limit category is inferred.
          const candidate = observation.retry_at ??
            new Date(now().getTime() + 60_000).toISOString();
          if (
            !next.blocked_until ||
            Date.parse(candidate) >= Date.parse(next.blocked_until)
          ) {
            next.blocked_until = candidate;
            next.observation = {
              ...observation,
              deadline_source: observation.retry_at
                ? "provider_retry_after"
                : "local_60s_fallback",
            };
          }
        }
        if (owner && next.probe?.owner === owner) {
          next.probe = null;
          // Only a successful owned probe can clear an EXPIRED hold. A late
          // success can never erase another request's newer future hold.
          if (
            response?.ok && next.blocked_until &&
            Date.parse(next.blocked_until) <= now().getTime()
          ) next.blocked_until = null;
        } else if (!observation) return;
        if (await cas(scope, state, next)) return;
      }
      throw unavailable();
    },
  };
}

export function createXeroCooldownFetch(options: {
  store: XeroCooldownStore;
  orgId: string;
  appKey: string | (() => Promise<string>);
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  onPersistenceFailure?: () => void;
}): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) {
    throw new Error("Xero transport deadline must be between 1 and 90000ms");
  }
  const guard = createXeroCooldownGuard(options.store, {
    now: options.now,
    probeLeaseMs: timeoutMs + 15_000,
  });
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const tenantId = headers.get("Xero-tenant-id");
    if (!tenantId) throw unavailable();
    const appKey = typeof options.appKey === "string"
      ? options.appKey
      : await options.appKey();
    const scope = { orgId: options.orgId, appKey, tenantId };
    const owner = await guard.beforeRequest(scope);
    // The probe lease exceeds this transport deadline. Existing caller abort
    // signals are preserved; no request is queued or retried in this wrapper.
    const timeout = AbortSignal.timeout(timeoutMs);
    const existing = init?.signal ??
      (input instanceof Request ? input.signal : null);
    const signal = existing ? AbortSignal.any([existing, timeout]) : timeout;
    let response: Response;
    try {
      response = await (options.fetchFn ?? fetch)(input, { ...init, signal });
    } catch (error) {
      try {
        await guard.afterResponse(scope, owner, null);
      } catch {
        options.onPersistenceFailure?.();
      }
      throw error;
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.xero.com") {
      if (url.pathname.startsWith("/projects.xro/2.0/")) {
        API_FAMILIES.set(response, "projects");
      } else if (url.pathname.startsWith("/api.xro/2.0/")) {
        API_FAMILIES.set(response, "accounting");
      }
    }
    try {
      await guard.afterResponse(scope, owner, response);
      REPORTS.set(response, {
        checked: true,
        persisted: response.status === 429 ? true : null,
        probe_released: owner ? true : null,
      });
    } catch {
      options.onPersistenceFailure?.();
      if (response.status === 429) {
        void response.body?.cancel().catch(() => {});
        throw new XeroCooldownError(
          "Xero rate limited; the shared cooldown could not be saved",
          429,
          "XERO_COOLDOWN_PERSISTENCE_FAILED",
          {
            ...xeroRateLimitDetails(response, options.now?.()),
            provider_called: true,
            provider_call_made: true,
            shared_guard: false,
          },
        );
      }
      // Do not turn a successful financial mutation into a retryable failure.
      // The owned probe lease expires; until then concurrent probes are refused.
      REPORTS.set(response, {
        checked: true,
        persisted: false,
        probe_released: false,
      });
    }
    return response;
  };
}
