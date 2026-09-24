// ════════════════════════════════════════════════════════════
// SecureWorks — GHL Marketplace app OAuth install callback
//
// Setup and install/receipt contract:
// docs/project-knowledge/edge-functions.md#ghl-oauth-callback---no-verify-jwt
//
// Never logged, stored or returned: the authorization code, any token, the
// client secret, or the provider's response body. Output is a small plain
// page carrying an outcome code only.
//
// Entry point: index.ts (serve). This module exports the handler so tests can
// drive it with a stubbed fetch and no network.
// ════════════════════════════════════════════════════════════

export const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const FUNCTION_NAME = "ghl-oauth-callback";
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const EXCHANGE_TIMEOUT_MS = 15_000;

export type InstallOutcome =
  | "installed"
  | "missing_code"
  | "missing_env"
  | "method_not_allowed"
  | "exchange_unreachable"
  | "exchange_rejected"
  | "exchange_invalid_response"
  | "location_mismatch";

export interface InstallReceipt {
  org_id: string;
  source: "ghl_oauth";
  event_type: "AppInstall";
  status: "processed" | "rejected" | "failed";
  error_message: string | null;
  payload: {
    receipt: "ghl_app_install_v1";
    outcome: InstallOutcome;
    location_id: string | null;
    company_id: string | null;
    provider_status: number | null;
  };
}

export interface CallbackDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  writeReceipt: (receipt: InstallReceipt) => Promise<void>;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** An identifier or null. Anything that is not a short id-shaped token is dropped. */
function safeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return ID_PATTERN.test(s) ? s : null;
}

function page(status: number, message: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>SecureWorks Live Feed</title></head><body><p>${message}</p>` +
    `</body></html>\n`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The request URL carries the authorization code; never leak it onward.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const SUCCESS_MESSAGE =
  "SecureWorks Live Feed installed. You can close this page.";

function errorPage(status: number, outcome: InstallOutcome): Response {
  return page(
    status,
    `SecureWorks Live Feed install did not complete. Error code: ${outcome}`,
  );
}

const STATUS_BY_OUTCOME: Record<InstallOutcome, number> = {
  installed: 200,
  missing_code: 400,
  missing_env: 500,
  method_not_allowed: 405,
  exchange_unreachable: 502,
  exchange_rejected: 502,
  exchange_invalid_response: 502,
  location_mismatch: 403,
};

export async function handleGhlOAuthCallback(
  req: Request,
  deps: CallbackDeps,
): Promise<Response> {
  let locationId: string | null = null;
  let companyId: string | null = null;
  let providerStatus: number | null = null;

  const finish = async (outcome: InstallOutcome): Promise<Response> => {
    if (outcome === "installed" || outcome === "location_mismatch") {
      const receipt: InstallReceipt = {
        org_id: DEFAULT_ORG_ID,
        source: "ghl_oauth",
        event_type: "AppInstall",
        status: outcome === "installed" ? "processed" : "rejected",
        error_message: outcome === "installed" ? null : outcome,
        payload: {
          receipt: "ghl_app_install_v1",
          outcome,
          location_id: locationId,
          company_id: companyId,
          provider_status: providerStatus,
        },
      };
      try {
        await deps.writeReceipt(receipt);
      } catch {
        console.error(`[${FUNCTION_NAME}] receipt write threw`);
      }
    }
    if (outcome !== "installed") {
      console.error(`[${FUNCTION_NAME}] install not completed: ${outcome}`);
    }
    return outcome === "installed"
      ? page(200, SUCCESS_MESSAGE)
      : errorPage(STATUS_BY_OUTCOME[outcome], outcome);
  };

  if (req.method !== "GET") return await finish("method_not_allowed");

  const code = new URL(req.url).searchParams.get("code");
  if (!code) return await finish("missing_code");

  const clientId = deps.env("GHL_APP_CLIENT_ID");
  const clientSecret = deps.env("GHL_APP_CLIENT_SECRET");
  const expectedLocation = deps.env("GHL_LOCATION_ID");
  const supabaseUrl = deps.env("SUPABASE_URL");
  if (!clientId || !clientSecret || !expectedLocation || !supabaseUrl) {
    return await finish("missing_env");
  }
  // The platform-facing URL of this function. req.url inside the edge runtime
  // is not guaranteed to be the public URL GHL redirected to.
  const redirectUri = `${
    supabaseUrl.replace(/\/+$/, "")
  }/functions/v1/${FUNCTION_NAME}`;

  let res: Response;
  try {
    res = await deps.fetch(GHL_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Version: "v3",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        user_type: "Location",
        redirect_uri: redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    return await finish("exchange_unreachable");
  }

  providerStatus = res.status;
  if (!res.ok) {
    // The provider body may echo request details; never read or keep it.
    await res.body?.cancel().catch(() => {});
    return await finish("exchange_rejected");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return await finish("exchange_invalid_response");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return await finish("exchange_invalid_response");
  }
  const rec = body as Record<string, unknown>;
  const installedLocation = safeId(rec.locationId);
  if (
    typeof rec.access_token !== "string" ||
    rec.access_token.trim().length === 0 ||
    !installedLocation
  ) {
    return await finish("exchange_invalid_response");
  }
  companyId = safeId(rec.companyId);
  if (installedLocation !== expectedLocation) {
    return await finish("location_mismatch");
  }
  locationId = installedLocation;
  return await finish("installed");
}
