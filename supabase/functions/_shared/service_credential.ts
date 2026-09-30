// Is this caller our own server? One answer for every edge function.
//
// Runbook: docs/evidence/legacy-service-role-key-removal-2026-09-30.md, Step 4.
//
// Two kinds of service credential are accepted, from any of the three headers a
// server caller uses (`x-api-key`, `Authorization: Bearer`, `apikey`):
//
//   secret_key          a new `sb_secret_...` key listed in SUPABASE_SECRET_KEYS
//                       (the platform injects it as a JSON object of name -> key).
//                       These are not JWTs; the runbook sends them as `apikey`.
//   legacy_service_role the old service-role JWT, accepted ONLY while the platform
//                       itself still accepts it.
//
// Why the legacy key needs a live check: comparing a presented token with
// SUPABASE_SERVICE_ROLE_KEY as a plain string never asks Supabase whether that
// key is still valid, so it would go on accepting the leaked key after the
// Captain deactivates the legacy keys in the dashboard. Before trusting a legacy
// key this module asks the project's own API gateway (GET /auth/v1/settings with
// the key as `apikey`). A 2xx means the platform still honours it; 401/403 means
// the key is switched off or not genuine, and it is refused from then on.
//
// Verdicts are cached per token for LEGACY_PROBE_TTL_MS so the gateway sees at
// most one probe per isolate per key per window. When the gateway cannot give an
// answer (network error, timeout, 5xx), the last definite verdict stands. With no
// definite verdict yet:
//   - the exact injected key is accepted: it is a server secret, the caller
//     cannot cause the outage, and the function's own database calls fail in the
//     same outage anyway, so refusing would only add a second failure;
//   - a token accepted only for its `role` claim is refused: a claim can be
//     forged by anyone, and the platform's signature check is the only thing that
//     makes it trustworthy.
//
// Nothing here logs, returns in a response, or stores a token outside process
// memory.

import { decodeJwtRole } from "./service_role_jwt.ts";

export type ServiceCredentialKind = "secret_key" | "legacy_service_role";
export type ServiceCredentialHeader = "x-api-key" | "authorization" | "apikey";

export interface ServiceCredential {
  kind: ServiceCredentialKind;
  /** The exact token the caller presented. Never log it. */
  token: string;
  header: ServiceCredentialHeader;
}

export type LegacyKeyVerdict = "accepted" | "rejected" | "unknown";
export type LegacyKeyProbe = (token: string) => Promise<LegacyKeyVerdict>;

export interface ServiceCredentialOptions {
  env?: (name: string) => string | undefined;
  /**
   * Which legacy tokens count as the service caller.
   * - `exact_env_key` (default): only a token equal to the injected
   *   SUPABASE_SERVICE_ROLE_KEY (or `legacyKeyEnvNames`).
   * - `service_role_claim`: also a JWT whose `role` claim is `service_role`.
   *   pg_cron calls with the Vault key, which need not equal the injected key;
   *   functions whose cron callers depend on that use this mode.
   */
  legacy?: "exact_env_key" | "service_role_claim";
  /** Env names holding the injected legacy key, first non-empty wins. */
  legacyKeyEnvNames?: string[];
  probe?: LegacyKeyProbe;
}

export const LEGACY_PROBE_TTL_MS = 5 * 60 * 1000;
const LEGACY_PROBE_TIMEOUT_MS = 5000;
const LEGACY_PROBE_CACHE_LIMIT = 32;
const SECRET_KEY_PREFIX = "sb_secret_";

// Captured once so a test that swaps globalThis.fetch for a recorder never sees
// a probe it did not ask for; probe tests inject their own fetch.
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** Values of SUPABASE_SECRET_KEYS that look like secret keys. Never throws. */
export function configuredSecretKeys(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      "[service_credential] SUPABASE_SECRET_KEYS is not valid JSON; no secret key accepted",
    );
    return [];
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
    ? Object.values(parsed as Record<string, unknown>)
    : [];
  return values.filter((v): v is string =>
    typeof v === "string" && v.startsWith(SECRET_KEY_PREFIX) &&
    v.length > SECRET_KEY_PREFIX.length
  );
}

/** Non-empty tokens from the three server-caller headers, in header order. */
export function presentedCredentials(
  headers: Headers,
): Array<{ header: ServiceCredentialHeader; token: string }> {
  const out: Array<{ header: ServiceCredentialHeader; token: string }> = [];
  const xApiKey = headers.get("x-api-key")?.trim();
  if (xApiKey) out.push({ header: "x-api-key", token: xApiKey });
  const auth = headers.get("authorization") || "";
  if (/^bearer /i.test(auth)) {
    const bearer = auth.slice(7).trim();
    if (bearer) out.push({ header: "authorization", token: bearer });
  }
  const apikey = headers.get("apikey")?.trim();
  if (apikey) out.push({ header: "apikey", token: apikey });
  return out;
}

/** Constant-time for equal lengths; length itself is not secret here. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function createLegacyKeyProbe(deps: {
  supabaseUrl: () => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}): LegacyKeyProbe {
  const fetchImpl = deps.fetchImpl ?? nativeFetch;
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? LEGACY_PROBE_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? LEGACY_PROBE_TIMEOUT_MS;
  const definite = new Map<
    string,
    { verdict: "accepted" | "rejected"; at: number }
  >();
  const inFlight = new Map<string, Promise<LegacyKeyVerdict>>();

  const remember = (token: string, verdict: "accepted" | "rejected") => {
    definite.delete(token);
    definite.set(token, { verdict, at: now() });
    while (definite.size > LEGACY_PROBE_CACHE_LIMIT) {
      const oldest = definite.keys().next().value;
      if (oldest === undefined) break;
      definite.delete(oldest);
    }
  };

  const ask = async (token: string): Promise<LegacyKeyVerdict> => {
    const base = (deps.supabaseUrl() || "").replace(/\/+$/, "");
    if (!base) return "unknown";
    try {
      const res = await fetchImpl(`${base}/auth/v1/settings`, {
        method: "GET",
        headers: { apikey: token },
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        await res.body?.cancel();
      } catch { /* body already consumed or absent */ }
      if (res.status >= 200 && res.status < 300) return "accepted";
      if (res.status === 401 || res.status === 403) return "rejected";
      return "unknown";
    } catch {
      return "unknown";
    }
  };

  return async (token: string) => {
    const known = definite.get(token);
    if (known && now() - known.at < ttlMs) return known.verdict;
    let pending = inFlight.get(token);
    if (!pending) {
      pending = ask(token).finally(() => inFlight.delete(token));
      inFlight.set(token, pending);
    }
    const verdict = await pending;
    if (verdict === "unknown") return definite.get(token)?.verdict ?? "unknown";
    remember(token, verdict);
    return verdict;
  };
}

let defaultProbe: LegacyKeyProbe | null = null;

function sharedDefaultProbe(): LegacyKeyProbe {
  if (!defaultProbe) {
    defaultProbe = createLegacyKeyProbe({
      supabaseUrl: () => Deno.env.get("SUPABASE_URL"),
    });
  }
  return defaultProbe;
}

/** Test seam: replace the shared probe (null restores the real one). */
export function _setDefaultLegacyKeyProbeForTest(
  probe: LegacyKeyProbe | null,
): void {
  defaultProbe = probe;
}

/**
 * The service credential this request presented, or null. A secret key wins over
 * a legacy key; a legacy key is returned only while the platform still accepts it.
 */
export async function verifyServiceCredential(
  headers: Headers,
  options: ServiceCredentialOptions = {},
): Promise<ServiceCredential | null> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const presented = presentedCredentials(headers);
  if (presented.length === 0) return null;

  const secretKeys = configuredSecretKeys(env("SUPABASE_SECRET_KEYS"));
  for (const p of presented) {
    if (secretKeys.some((k) => timingSafeEqualString(p.token, k))) {
      return { kind: "secret_key", token: p.token, header: p.header };
    }
  }

  const legacyKey = (options.legacyKeyEnvNames ?? ["SUPABASE_SERVICE_ROLE_KEY"])
    .map((name) => env(name) || "")
    .find((v) => v.length > 0) || "";
  const claimMode = options.legacy === "service_role_claim";
  const probe = options.probe ?? sharedDefaultProbe();

  for (const p of presented) {
    // A secret-key-shaped token is never a legacy JWT.
    if (p.token.startsWith(SECRET_KEY_PREFIX)) continue;
    const exact = legacyKey.length > 0 &&
      timingSafeEqualString(p.token, legacyKey);
    const claim = !exact && claimMode &&
      decodeJwtRole(p.token) === "service_role";
    if (!exact && !claim) continue;
    const verdict = await probe(p.token);
    if (verdict === "accepted" || (verdict === "unknown" && exact)) {
      return { kind: "legacy_service_role", token: p.token, header: p.header };
    }
  }
  return null;
}
