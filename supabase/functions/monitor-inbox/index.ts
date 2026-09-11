import { runMailStreams } from "./mail_run.ts";
import { automationLaneEnabled } from "../_shared/automation_switch.ts";
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GraphFailure, graphUrl } from "./mail_capture.ts";
import { persistMail } from "./mail_persistence.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_KEY")!;
const SW_API_KEY = Deno.env.get("SW_API_KEY") || "";
// Graph token cache
let _cachedToken: { token: string; expires: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expires > Date.now() + 300000) {
    return _cachedToken.token;
  }

  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set",
    );
  }

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph token request failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  _cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in * 1000),
  };
  return data.access_token;
}

Deno.serve(async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const bearer = (req.headers.get("authorization") || "").replace(
    /^Bearer /i,
    "",
  );
  if (
    !(SW_API_KEY && req.headers.get("x-api-key") === SW_API_KEY) &&
    !(SUPABASE_SERVICE_KEY && bearer === SUPABASE_SERVICE_KEY)
  ) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers,
    });
  }
  const coverage: Record<string, unknown>[] = [];
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    if (!(await automationLaneEnabled(sb, "capture"))) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "automation_lane_disabled" }),
        { headers },
      );
    }
    const { data: streams, error: listError } = await sb.from(
      "context_mail_streams",
    ).select("stream_key,mailbox,kind,folder,enabled,unavailable_reason").order(
      "last_started_at",
      { ascending: true, nullsFirst: true },
    );
    if (listError || !streams?.length) {
      throw new Error("mail_stream_registry_unavailable");
    }
    const token = await getGraphToken();
    const get = async (url: string) => {
      const response = await fetch(graphUrl(url), {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: "odata.maxpagesize=25",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new GraphFailure(response.status);
      return await response.json();
    };
    coverage.push(
      ...await runMailStreams(
        sb,
        get,
        streams,
        (mail, stream, url) => persistMail(sb, get, mail, stream, url),
      ),
    );
    const success = coverage.every((row) => row.status === "complete");
    return new Response(
      JSON.stringify({
        success,
        coverage,
        timestamp: new Date().toISOString(),
      }),
      { status: success ? 200 : 207, headers },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "capture_failed",
        coverage,
      }),
      { status: 500, headers },
    );
  }
});
