// Route auth decisions for the functions contained by shared_key_containment.ts.
//
// ops-ai, agent-runner and completion-pack boot serve() on import, so their
// handlers cannot be driven in a unit test. Each route's auth decision lives
// here instead, with its verifiers injected, and the route calls it. The tests
// in shared_key_route_auth_test.ts drive these with real Request headers.
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
