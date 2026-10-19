// Route auth decisions for the functions contained by shared_key_containment.ts.
//
// ops-ai, agent-runner, completion-pack and send-po-email each take their auth
// decision from here, with the verifiers injected. shared_key_route_auth_test.ts
// drives these helpers with real Request headers, and
// shared_key_route_handlers_test.ts drives the four exported handlers
// themselves (each route serves only when it is the main module).
//
// Nothing here logs, returns or stores a credential.

import { isSharedKey, sharedKeyGate } from "./shared_key_containment.ts";

type EnvGet = (name: string) => string | undefined;

/**
 * completion-pack and send-po-email: the shared key (while containment is off)
 * or a service credential. No user JWT path.
 */
export async function authorizeKeyOrServiceCaller(input: {
  req: Request;
  fn: string;
  sharedKey: string | null | undefined;
  verifyService: (headers: Headers) => Promise<unknown>;
  env?: EnvGet;
}): Promise<boolean> {
  const { req } = input;
  const apiKey = req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  const sharedKeyOk = sharedKeyGate({
    presented: [apiKey],
    sharedKey: input.sharedKey,
    fn: input.fn,
    env: input.env,
    headers: req.headers,
  }) === "accepted";
  return sharedKeyOk || !!(await input.verifyService(req.headers));
}

/**
 * ops-ai and agent-runner: a service credential, the shared key (while
 * containment is off), or a signed-in user's JWT. A Bearer that is the shared
 * key is never sent to the user JWT check.
 */
export async function authorizeKeyServiceOrUser(input: {
  req: Request;
  fn: string;
  sharedKey: string | null | undefined;
  verifyService: (headers: Headers) => Promise<unknown>;
  verifyUserJwt: (token: string) => Promise<boolean>;
  env?: EnvGet;
}): Promise<boolean> {
  const { req } = input;
  const xApiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (await input.verifyService(req.headers)) return true;
  if (
    sharedKeyGate({
      presented: [xApiKey, bearerToken],
      sharedKey: input.sharedKey,
      fn: input.fn,
      env: input.env,
      headers: req.headers,
    }) === "accepted"
  ) return true;
  if (bearerToken && !isSharedKey(bearerToken, input.sharedKey)) {
    try {
      return await input.verifyUserJwt(bearerToken);
    } catch {
      return false;
    }
  }
  return false;
}
