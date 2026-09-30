// In-code caller check for edge functions that used to rely only on the
// platform's "verify JWT" gateway check (runbook Step 4 D,
// docs/evidence/legacy-service-role-key-removal-2026-09-30.md).
//
// The gateway admitted any validly signed project JWT: the service-role key,
// a signed-in user's session, and the public anon key. The new sb_secret_ keys
// are not JWTs, so the gateway check has to come off before callers can move
// to them, and each function must then check its callers itself.
//
// This gate admits:
//   - a service credential verified by verifyServiceCredential, in
//     `service_role_claim` mode: pg_cron calls with the Vault key, a
//     service-role JWT that need not equal the injected key, so the role claim
//     counts, but only once the project's gateway confirms that exact token;
//   - a signed-in user session, only where the function allows it, checked by
//     the caller-supplied isUserSession (auth.getUser).
// It refuses the public anon key and anything unauthenticated.

import {
  type ServiceCredentialOptions,
  verifyServiceCredential,
} from "./service_credential.ts";

export interface ServerCallerGateDeps {
  allowUserSession: boolean;
  /** True when the Bearer is a live user session (auth.getUser succeeds). */
  isUserSession?: (jwt: string) => Promise<boolean>;
  credentialOptions?: ServiceCredentialOptions;
}

export async function authorizeServerCaller(
  req: Request,
  deps: ServerCallerGateDeps,
): Promise<boolean> {
  const credential = await verifyServiceCredential(req.headers, {
    legacy: "service_role_claim",
    ...deps.credentialOptions,
  });
  if (credential) return true;
  if (!deps.allowUserSession || !deps.isUserSession) return false;
  const auth = req.headers.get("authorization") || "";
  const bearer = /^bearer /i.test(auth) ? auth.slice(7).trim() : "";
  if (!bearer) return false;
  try {
    return await deps.isUserSession(bearer);
  } catch {
    return false;
  }
}
