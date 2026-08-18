import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { presentSesPackHonesty } from "./ses_pack_presentation.ts";

Deno.test("ready docket supersedes legacy failed — never presents failed or refused", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-ready",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    legacy_pack: {
      status: "failed",
      failed_step: "draft_pack",
      error_detail: "Claude draft response did not contain a JSON object",
    },
  });
  assertEquals(p.kind, "ready");
  assertEquals(p.state, "drafted");
  assertEquals(p.review_state, "READY");
  assertEquals(p.pre_xero_docs_ready, true);
  assertEquals(p.docket_revision_id, "rev-ready");
  assertEquals(p.reason, null);
  assertEquals(p.legacy_pack_status, "failed");
  assertEquals(p.blockers, []);
});

Deno.test("docket blockers present as refused with fact, not failed and not ready", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-blocked",
      state: "blocked",
      pre_xero_docs_ready: false,
      blockers: [{
        state: "refused",
        code: "curated_source_missing",
        fact:
          "The completion report lacks an independently byte-bound current-cycle curated source, so it is hidden from the trusted pack.",
        recovery_action:
          "Bind a current-cycle curated report, then re-prepare.",
      }],
    },
    legacy_pack: { status: "drafted" },
  });
  assertEquals(p.kind, "refused");
  assertEquals(p.state, "refused");
  assertEquals(p.review_state, "U4_BLOCKED");
  assertEquals(p.pre_xero_docs_ready, false);
  assertStringIncludes(p.reason || "", "independently byte-bound");
  assertEquals(p.blockers[0].code, "curated_source_missing");
  assertEquals(p.blockers[0].category, "ses_docket");
  // Refusal is not a green ready and not a send-pipeline failed.
  assertEquals(p.state === "failed", false);
  assertEquals(p.kind === "ready", false);
});

Deno.test("read-time review trust refusal is refused even when stored docket was ready", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-stale-trust",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    review_blockers: [{
      code: "curated_source_missing",
      fact: "The completion report lacks an independently byte-bound source.",
      recovery_action: "Re-bind and re-prepare.",
    }],
  });
  assertEquals(p.kind, "refused");
  assertEquals(p.state, "refused");
  assertEquals(p.review_state, "U4_BLOCKED");
  assertEquals(p.pre_xero_docs_ready, false);
  assertStringIncludes(p.reason || "", "independently byte-bound");
});

Deno.test("no docket and legacy failed is refused with the stored reason", () => {
  const p = presentSesPackHonesty({
    docket: null,
    legacy_pack: {
      status: "failed",
      failed_step: "draft_pack",
      error_detail: "Claude draft response did not contain a JSON object",
    },
  });
  assertEquals(p.kind, "refused");
  assertEquals(p.state, "refused");
  assertStringIncludes(p.reason || "", "Claude draft response");
  assertEquals(p.blockers[0].category, "legacy_pack");
  assertEquals(p.drafted, false);
});

Deno.test("no docket with report evidence only is incomplete, not refused", () => {
  const p = presentSesPackHonesty({
    docket: null,
    legacy_pack: null,
    has_report_doc: true,
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.state, "not_started");
  assertStringIncludes(p.reason || "", "no SES pack has been assembled");
});

Deno.test("trade report in with no pack is incomplete, not refused and not ready", () => {
  const p = presentSesPackHonesty({
    docket: null,
    legacy_pack: null,
    has_trade_report: true,
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.state, "not_started");
  assertStringIncludes(p.reason || "", "trade report is in");
  assertEquals(p.drafted, false);
});

Deno.test("docket present but not ready without blockers is incomplete", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-assembling",
      state: "drafting",
      pre_xero_docs_ready: false,
      blockers: [],
    },
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.review_state, "U4_BLOCKED");
  assertStringIncludes(p.reason || "", "still assembling");
});

Deno.test("sent pack is sent even when a current docket also exists", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-sent",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    legacy_pack: { status: "sent" },
    pack_sent: true,
  });
  assertEquals(p.kind, "sent");
  assertEquals(p.state, "sent");
  assertEquals(p.reason, null);
});

Deno.test("authorised-not-sent over a ready docket stays ready and names the send", () => {
  const p = presentSesPackHonesty({
    docket: { id: "rev-ready", pre_xero_docs_ready: true, blockers: [] },
    legacy_pack: { status: "authorised_not_sent" },
  });
  assertEquals(p.kind, "ready");
  assertEquals(p.state, "authorised_not_sent");
  assertEquals(p.legacy_pack_status, "authorised_not_sent");
  assertEquals(p.blockers, []);
  assertStringIncludes(String(p.reason), "awaiting send");

  const fresh = presentSesPackHonesty({
    docket: { id: "rev-ready", pre_xero_docs_ready: true, blockers: [] },
    legacy_pack: { status: "drafted" },
  });
  assertEquals(fresh.state, "drafted");
  assertEquals(fresh.reason, null);
});

Deno.test("three kinds stay distinct — ready / refused / incomplete", () => {
  const ready = presentSesPackHonesty({
    docket: { id: "a", pre_xero_docs_ready: true, blockers: [] },
  });
  const refused = presentSesPackHonesty({
    docket: {
      id: "b",
      pre_xero_docs_ready: false,
      blockers: [{
        reason_code: "pricing_evidence_missing",
        fact: "No price.",
      }],
    },
  });
  const incomplete = presentSesPackHonesty({
    docket: null,
    has_trade_report: true,
  });
  assertEquals(ready.kind, "ready");
  assertEquals(refused.kind, "refused");
  assertEquals(incomplete.kind, "incomplete");
  // Never collapse all three into one warning state.
  assertEquals(new Set([ready.kind, refused.kind, incomplete.kind]).size, 3);
});

Deno.test("physical ready stamp without report_doc_id is incomplete — attach is not a bind", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-ready-no-bind",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    has_report_doc: true,
    report_doc_id: null,
    requires_bound_report_doc: true,
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.review_state, "U4_BLOCKED");
  assertEquals(p.pre_xero_docs_ready, false);
  assertStringIncludes(p.reason || "", "report_doc_id");
});

Deno.test("physical ready stamp with bound report_doc_id stays ready", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-ready-bound",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    report_doc_id: "doc-report",
    requires_bound_report_doc: true,
  });
  assertEquals(p.kind, "ready");
  assertEquals(p.review_state, "READY");
  assertEquals(p.pre_xero_docs_ready, true);
});

Deno.test("required-SWMS ready stamp without swms_doc_id is incomplete — attach is not a bind", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-ready-no-swms-bind",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    report_doc_id: "doc-report",
    requires_bound_report_doc: true,
    swms_doc_id: null,
    requires_bound_swms: true,
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.review_state, "U4_BLOCKED");
  assertEquals(p.pre_xero_docs_ready, false);
  assertStringIncludes(p.reason || "", "swms_doc_id");
});

Deno.test("required-SWMS ready stamp with bound swms_doc_id stays ready", () => {
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-ready-swms-bound",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    report_doc_id: "doc-report",
    requires_bound_report_doc: true,
    swms_doc_id: "doc-swms",
    requires_bound_swms: true,
  });
  assertEquals(p.kind, "ready");
  assertEquals(p.review_state, "READY");
  assertEquals(p.pre_xero_docs_ready, true);
});

Deno.test("assessment ready stamp without family report evidence is not send-ready", () => {
  // SWMS-261243 class: docket pre_xero_docs_ready with no portal/report proof.
  const p = presentSesPackHonesty({
    docket: {
      id: "rev-assess-stamp",
      state: "ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    report_doc_id: null,
    requires_bound_report_doc: false,
    family_report_evidence_satisfied: false,
  });
  assertEquals(p.kind, "incomplete");
  assertEquals(p.pre_xero_docs_ready, false);
  assertStringIncludes(p.reason || "", "family report evidence");
});
