// ════════════════════════════════════════════════════════════
// A1 — reextract_intake_draft (in-place re-extraction) TESTS
// ════════════════════════════════════════════════════════════
// The extraction itself (model + storage) is injected so the ORCHESTRATION (load /
// refuse / UPDATE-in-place / status / auto-file gate / business_event) is exercised
// deterministically with no network. Auto-file is kept OFF (config) so the heavy
// approveIntakeDraft path is not invoked here.
//
// RUN: deno test --no-check --allow-all supabase/functions/ops-api/makesafe_reextract_test.ts

import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _assertDraftReextractable, reextractIntakeDraft } from "./index.ts";

// ── pure guard ──
Deno.test("reextract guard: refuses approved/rejected, allows in-flight states", () => {
  for (const s of ["approved", "rejected", "APPROVED"]) {
    let threw = false;
    try { _assertDraftReextractable(s); } catch { threw = true; }
    assert(threw, `expected refusal for ${s}`);
  }
  for (const s of ["draft", "needs_review", "superseded", "reopen_candidate", null, undefined]) {
    _assertDraftReextractable(s as any); // must NOT throw
  }
});

// ── fake table-aware client ──
function makeClient(cfg: { draft: any; email: any; companies?: any[]; autoFile?: boolean }) {
  const captured: any = { update: null, events: [] };
  const make = (table: string) => {
    const state: any = { table, op: "select", updateRow: null };
    const resolveSingle = () => {
      if (table === "makesafe_intake_drafts") {
        if (state.op === "update") {
          captured.update = state.updateRow;
          return { data: { ...cfg.draft, ...state.updateRow }, error: null };
        }
        return { data: cfg.draft, error: cfg.draft ? null : { message: "not found" } };
      }
      if (table === "emails") return { data: cfg.email, error: null };
      if (table === "makesafe_cron_settings") return { data: { auto_file_enabled: !!cfg.autoFile }, error: null };
      return { data: null, error: null };
    };
    const chain: any = {
      select: () => chain,
      update: (row: any) => { state.op = "update"; state.updateRow = row; return chain; },
      insert: (row: any) => { captured.events.push({ table, row }); return Promise.resolve({ error: null }); },
      eq: () => chain,
      single: async () => resolveSingle(),
      maybeSingle: async () => resolveSingle(),
      // thenable: `await client.from('makesafe_companies').select().eq('active', true)`
      then: (onF: any, onR: any) =>
        Promise.resolve(table === "makesafe_companies" ? { data: cfg.companies ?? [], error: null } : { data: [], error: null }).then(onF, onR),
    };
    return chain;
  };
  return { from: make, _captured: captured };
}

const EMAIL = { post_id: "AAMk1", subject: "NEW WORK ORDER - MLB-26678 80 San Jacinta Rd", body_content: "body", body_preview: "body", from_email: "mlb.mailer@primeeco.tech", from_name: "MLB", has_attachments: false, received_at: "2026-07-04T00:00:00Z" };

function fakeExtractor(result: any) {
  return async (_client: any, _input: any) => result;
}

const CLEAN = {
  extraction: { external_ref: "MLB-26678", client_name: "Jo", client_phone: null, site_address: "80 San Jacinta Rd", site_suburb: "Seville Grove", description: "make safe", safety_requirements: null },
  attachments: [{ pdf_url: "https://x/wo.pdf", is_work_order: true }],
  confidence: "high", missingFields: [], matchedCompany: { slug: "mlb", name: "ML Builders" },
  draftReportType: null, draftJobFamily: "general_makesafe", availableWoCount: 1,
  isReportCapture: false, extractionDegraded: false, woGateOk: true, woGateReason: "new_work_order_subject",
};

Deno.test("reextract: refuses a finalised (approved) draft", async () => {
  const client = makeClient({ draft: { id: "d1", status: "approved", graph_message_id: "AAMk1" }, email: EMAIL, autoFile: false });
  await assertRejects(() => reextractIntakeDraft(client as any, { draft_id: "d1" }, { extractFields: fakeExtractor(CLEAN) as any }));
});

Deno.test("reextract: clean result UPDATES in place -> needs_review + business_event, no auto-file when disabled", async () => {
  const client = makeClient({ draft: { id: "d1", status: "draft", graph_message_id: "AAMk1" }, email: EMAIL, companies: [{ slug: "mlb", name: "ML Builders", sender_patterns: ["@primeeco.tech"], parsing_rules: null }], autoFile: false });
  const r = await reextractIntakeDraft(client as any, { draft_id: "d1" }, { extractFields: fakeExtractor(CLEAN) as any });
  assertEquals(r.ok, true);
  assertEquals(r.status, "needs_review");
  assertEquals(r.external_ref, "MLB-26678");
  assertEquals(r.auto_filed, null);
  // UPDATE captured with mapped fields (in place; never an INSERT)
  assertEquals(client._captured.update.external_ref, "MLB-26678");
  assertEquals(client._captured.update.site_address, "80 San Jacinta Rd");
  assertEquals(client._captured.update.status, "needs_review");
  assertStringIncludes(client._captured.update.review_notes, "Re-extracted in place");
  // business_event breadcrumb emitted
  assert(client._captured.events.some((e: any) => e.row.event_type === "makesafe.intake_reextracted"));
});

Deno.test("reextract: a missing required field re-extracts to 'draft' (incomplete)", async () => {
  const incomplete = { ...CLEAN, extraction: { ...CLEAN.extraction, external_ref: null }, availableWoCount: 1 };
  const client = makeClient({ draft: { id: "d1", status: "needs_review", graph_message_id: "AAMk1" }, email: EMAIL, autoFile: false });
  const r = await reextractIntakeDraft(client as any, { draft_id: "d1" }, { extractFields: fakeExtractor(incomplete) as any });
  assertEquals(r.status, "draft");
  assertEquals(client._captured.update.status, "draft");
});

Deno.test("reextract: a degraded extraction stays needs_review and never auto-files", async () => {
  const degraded = { ...CLEAN, extractionDegraded: true, confidence: "low", missingFields: ["extraction_down_key_dead"] };
  const client = makeClient({ draft: { id: "d1", status: "draft", graph_message_id: "AAMk1" }, email: EMAIL, autoFile: true });
  const r = await reextractIntakeDraft(client as any, { draft_id: "d1" }, { extractFields: fakeExtractor(degraded) as any });
  assertEquals(r.status, "needs_review");
  assertEquals(r.extraction_degraded, true);
  assertEquals(r.auto_filed, null); // degraded suppresses auto-file
});

Deno.test("reextract: requires draft_id", async () => {
  const client = makeClient({ draft: null, email: EMAIL });
  await assertRejects(() => reextractIntakeDraft(client as any, {}, { extractFields: fakeExtractor(CLEAN) as any }));
});
