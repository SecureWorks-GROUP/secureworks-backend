// ════════════════════════════════════════════════════════════
// SecureWorks — First-contact + lead-source backfill (M0 · U2)
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U2). Contract §3 + §2a.
//
// Walks existing jobs + contacts and reports (dry-run) OR applies the
// first-contact / lead-source stamps that the live path only fills going
// forward. Reuses the shared helpers in _shared/evidence/first_contact.ts so
// the backfill and the runtime stamping can never drift.
//
//   DRY-RUN IS THE DEFAULT. Apply requires BOTH ?apply=1 AND the
//   first_contact_stamp_v1 flag ON — the same kill-switch that gates the
//   runtime path. Dry-run performs SELECTs only and writes nothing.
//
// Deploy: supabase functions deploy first-contact-backfill --no-verify-jwt
// Invoke (dry-run):  curl -H 'x-api-key: $SW_API_KEY' '.../first-contact-backfill'
//                    ?limit=500&offset=0     paginate the job scan
// Invoke (apply):    ...?apply=1   (blocked unless first_contact_stamp_v1 is ON;
//                    Marnin-gated per the mission contract — do not run without
//                    his explicit go)
// ════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isFlagOn } from "../_shared/evidence/feature_flag.ts";
import {
  propagateJobFirstContactAndLeadSource,
  stampContactFirstSeen,
} from "../_shared/evidence/first_contact.ts";

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
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const applyRequested = url.searchParams.get("apply") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), 2000);
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const sampleMax = Number(url.searchParams.get("sample") ?? "25");

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Apply is double-gated: explicit ?apply=1 AND the kill-switch flag ON.
  let applyMode = false;
  if (applyRequested) {
    const flagOn = await isFlagOn(sb, "first_contact_stamp_v1", DEFAULT_ORG_ID);
    if (!flagOn) {
      return json({
        error: "apply refused: first_contact_stamp_v1 flag is OFF",
        hint: "Enable the flag (Marnin-gated per mission contract) then retry ?apply=1",
      }, 409);
    }
    applyMode = true;
  }
  const dry_run = !applyMode;

  // ── BEFORE counts (exact) ────────────────────────────────────────────────
  const before = {
    jobs_total: await count(sb, "jobs"),
    jobs_with_contact: await count(sb, "jobs", (q) => q.not("ghl_contact_id", "is", null)),
    jobs_missing_first_contacted_at: await count(
      sb, "jobs", (q) => q.is("first_contacted_at", null).not("ghl_contact_id", "is", null),
    ),
    jobs_missing_lead_source: await count(sb, "jobs", (q) => q.is("lead_source", null)),
    contact_matches_total: await count(sb, "contact_matches"),
    contacts_missing_first_seen: await count(
      sb, "contact_matches", (q) => q.is("contact_first_seen_at", null),
    ),
  };

  // ── Jobs pass ─────────────────────────────────────────────────────────────
  const { data: jobs, error: jobErr } = await sb
    .from("jobs")
    .select("id")
    .not("ghl_contact_id", "is", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (jobErr) return json({ error: `job scan failed: ${jobErr.message}` }, 500);

  let jobsScanned = 0;
  let wouldSetFirstContact = 0;
  let wouldSetLeadSource = 0;
  // deno-lint-ignore no-explicit-any
  const jobSamples: any[] = [];
  for (const j of jobs ?? []) {
    jobsScanned++;
    try {
      const r = await propagateJobFirstContactAndLeadSource(sb, { jobId: j.id, dry_run });
      if (r.patch?.first_contacted_at) wouldSetFirstContact++;
      if (r.patch?.lead_source) wouldSetLeadSource++;
      if (r.changed && jobSamples.length < sampleMax) {
        jobSamples.push({ job_id: j.id, patch: r.patch, lead_source: r.lead_source });
      }
    } catch (e) {
      if (jobSamples.length < sampleMax) {
        jobSamples.push({ job_id: j.id, error: (e as Error).message });
      }
    }
  }

  // ── Contacts pass (lifetime) ────────────────────────────────────────────────
  const { data: contacts, error: cErr } = await sb
    .from("contact_matches")
    .select("ghl_contact_id")
    .not("ghl_contact_id", "is", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (cErr) return json({ error: `contact scan failed: ${cErr.message}` }, 500);

  const seen = new Set<string>();
  let contactsScanned = 0;
  let wouldSetLifetime = 0;
  // deno-lint-ignore no-explicit-any
  const contactSamples: any[] = [];
  for (const c of contacts ?? []) {
    if (seen.has(c.ghl_contact_id)) continue;
    seen.add(c.ghl_contact_id);
    contactsScanned++;
    try {
      const r = await stampContactFirstSeen(sb, { ghlContactId: c.ghl_contact_id, dry_run });
      if (r.changed) {
        wouldSetLifetime++;
        if (contactSamples.length < sampleMax) {
          contactSamples.push({ ghl_contact_id: c.ghl_contact_id, first_seen: r.after });
        }
      }
    } catch (e) {
      if (contactSamples.length < sampleMax) {
        contactSamples.push({ ghl_contact_id: c.ghl_contact_id, error: (e as Error).message });
      }
    }
  }

  return json({
    mode: dry_run ? "dry_run" : "APPLIED",
    window: { limit, offset },
    before,
    jobs_pass: {
      scanned: jobsScanned,
      would_set_first_contacted_at: wouldSetFirstContact,
      would_set_lead_source: wouldSetLeadSource,
      samples: jobSamples,
    },
    contacts_pass: {
      scanned: contactsScanned,
      would_set_contact_first_seen_at: wouldSetLifetime,
      samples: contactSamples,
    },
    note: dry_run
      ? "No rows written. Re-run with ?apply=1 (flag-gated, Marnin-approved) to apply."
      : "Rows updated via the shared idempotent stamping helpers.",
  });
});

// deno-lint-ignore no-explicit-any
async function count(
  sb: any,
  table: string,
  // deno-lint-ignore no-explicit-any
  build?: (q: any) => any,
): Promise<number> {
  let q = sb.from(table).select("id", { count: "exact", head: true });
  if (build) q = build(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return n ?? 0;
}
