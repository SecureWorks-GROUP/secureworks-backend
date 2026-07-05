// ════════════════════════════════════════════════════════════
// SecureWorks — from_site_estimated historical labeller (M0 · U3)
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U3). Contract §2a call 4.
//
// Labels HISTORICAL quote.sent events with payload.from_site_estimated='true'
// when a frozen scope sign-off for the same job happened within 4h BEFORE the
// send. This is CONTEXT ONLY and is NEVER counted toward the D10 "quoted from
// site" number — Deckhand B's scoreboard counts payload.from_site='true'
// exclusively (the strict, server-verified flag), never the estimate.
//
//   DRY-RUN IS THE DEFAULT and writes nothing. Apply requires ?apply=1 AND the
//   from_site_proof_v1 flag ON — Marnin-gated per the mission contract.
//
// Deploy: supabase functions deploy from-site-estimate-backfill --no-verify-jwt
// Invoke (dry-run): curl -H 'x-api-key: $SW_API_KEY' '.../from-site-estimate-backfill?days=180'
// ════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isFlagOn } from "../_shared/evidence/feature_flag.ts";
import {
  FROM_SITE_ESTIMATE_WINDOW_HOURS,
  FROM_SITE_FLAG,
  isFromSiteEstimated,
} from "../_shared/scope/from_site.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};
// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const days = Math.min(Number(url.searchParams.get("days") ?? "180"), 720);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "1000"), 5000);
  const sampleMax = Number(url.searchParams.get("sample") ?? "25");
  const applyRequested = url.searchParams.get("apply") === "1";

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  let applyMode = false;
  if (applyRequested) {
    if (!(await isFlagOn(sb, FROM_SITE_FLAG, DEFAULT_ORG_ID))) {
      return json({ error: `apply refused: ${FROM_SITE_FLAG} is OFF`, hint: "Marnin-gated; enable the flag then retry ?apply=1" }, 409);
    }
    applyMode = true;
  }
  const dry_run = !applyMode;
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

  const { data: quotes, error } = await sb
    .from("business_events")
    .select("id, job_id, occurred_at, payload")
    .eq("event_type", "quote.sent")
    .gte("occurred_at", sinceIso)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: `quote scan failed: ${error.message}` }, 500);

  let scanned = 0, wouldLabel = 0, alreadyStrict = 0, alreadyEstimated = 0;
  // deno-lint-ignore no-explicit-any
  const samples: any[] = [];
  for (const q of quotes ?? []) {
    scanned++;
    const p = (q.payload ?? {}) as Record<string, unknown>;
    if (p.from_site === "true") { alreadyStrict++; continue; } // strict flag wins; never overwrite
    if (p.from_site_estimated === "true") { alreadyEstimated++; continue; }
    if (!q.job_id) continue;

    // Frozen scope sign-offs for this job (durable historical provenance).
    const { data: revs } = await sb
      .from("scope_revisions")
      .select("frozen_at")
      .eq("job_id", q.job_id)
      .not("frozen_at", "is", null);
    const signoffs = (revs ?? []).map((r: { frozen_at: string }) => r.frozen_at);
    if (!isFromSiteEstimated(q.occurred_at, signoffs)) continue;

    wouldLabel++;
    if (samples.length < sampleMax) samples.push({ event_id: q.id, job_id: q.job_id, occurred_at: q.occurred_at });
    if (!dry_run) {
      await sb.from("business_events").update({ payload: { ...p, from_site_estimated: "true" } }).eq("id", q.id);
    }
  }

  return json({
    mode: dry_run ? "dry_run" : "APPLIED",
    window: { days, window_hours: FROM_SITE_ESTIMATE_WINDOW_HOURS, limit },
    scanned,
    would_label_from_site_estimated: wouldLabel,
    skipped_already_strict: alreadyStrict,
    skipped_already_estimated: alreadyEstimated,
    samples,
    note: "from_site_estimated is CONTEXT ONLY and is NEVER counted toward D10 (scoreboard counts payload.from_site='true' only).",
  });
});
