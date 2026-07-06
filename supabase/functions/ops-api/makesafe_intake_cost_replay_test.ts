// Tests for the M1.5 cost-preview + template-agreement fields on the golden replay
// (makesafe_intake_golden_replay.ts). Deterministic, key-less — proves would_call_model
// / pdf_mode / parser and the template-vs-actual agreement before any builder is flipped.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type GoldenDraft,
  type GoldenEmail,
  type GoldenSenderPattern,
  replayGoldenEmail,
  summarizeGoldenReplay,
} from "./makesafe_intake_golden_replay.ts";
import { senderMatchesPattern } from "../_shared/makesafe_intake_classification.ts";
import type { TemplateParsingRules } from "./makesafe_template_parser.ts";

const MLB_PATTERNS: GoldenSenderPattern[] = [
  { slug: "mlb", name: "MLB", pattern: "mlb.com.au" },
];

const MLB_FIELDS: TemplateParsingRules["fields"] = {
  external_ref: { regex: "\\b(MLB[-\\s]?\\d{4,6})\\b", source: "all", group: 1, transform: "upper" },
  client_name: { regex: "Client:\\s*([A-Za-z ]+)", source: "all", group: 1, transform: "collapse_ws" },
  site_address: { regex: "Address:\\s*([0-9][^\\n]+)", source: "all", group: 1, transform: "collapse_ws" },
};

function mlbRules(templateFirst: boolean): Map<string, TemplateParsingRules> {
  return new Map([["mlb", {
    version: 1,
    template_first: templateFirst,
    confidence: "high",
    required: ["external_ref", "client_name", "site_address"],
    fields: MLB_FIELDS,
  }]]);
}

const CLEAN_WO: GoldenEmail = {
  post_id: "post-mlb-1",
  subject: "NEW WORK ORDER MLB-25795 make safe",
  from_email: "dispatch@mlb.com.au",
  from_name: "MLB Dispatch",
  body: "Please attend.",
  has_attachments: true,
  received_at: "2026-07-03T00:00:00Z",
  wo_pdf_count: 1,
  pdf_mode: "text",
  pdf_text: "Client: Jane Doe\nAddress: 12 Smith Street Perth",
};

Deno.test("template-first builder + full parse -> would_call_model=false, parser='template'", () => {
  const r = replayGoldenEmail(CLEAN_WO, MLB_PATTERNS, senderMatchesPattern, mlbRules(true));
  assertEquals(r.is_candidate, true);
  assertEquals(r.matched_company, "mlb");
  assertEquals(r.template_full_parse, true);
  assertEquals(r.template_first, true);
  assertEquals(r.would_call_model, false);
  assertEquals(r.parser, "template");
  assertEquals(r.pdf_mode, "text");
});

Deno.test("per-builder toggle DEFAULT-OFF: template parses but would_call_model stays true", () => {
  const r = replayGoldenEmail(CLEAN_WO, MLB_PATTERNS, senderMatchesPattern, mlbRules(false));
  assertEquals(r.template_full_parse, true); // fields parse
  assertEquals(r.template_first, false);
  assertEquals(r.would_call_model, true); // toggle off -> model still called
  assertEquals(r.parser, "none");
});

Deno.test("no rules for the builder -> model-first, no template", () => {
  const r = replayGoldenEmail(CLEAN_WO, MLB_PATTERNS, senderMatchesPattern, new Map());
  assertEquals(r.would_call_model, true);
  assertEquals(r.template_full_parse, false);
  assertEquals(r.template_first, false);
});

Deno.test("pdf_mode falls back to a conservative default when the extractor didn't run", () => {
  const noExtract: GoldenEmail = { ...CLEAN_WO, pdf_mode: undefined, pdf_text: null };
  const r = replayGoldenEmail(noExtract, MLB_PATTERNS, senderMatchesPattern, mlbRules(false));
  assertEquals(r.pdf_mode, "document"); // wo_pdf_count > 0 but no extracted text
});

Deno.test("summary: cost counts + template agreement vs the actual draft", () => {
  const draft: GoldenDraft = {
    graph_message_id: "post-mlb-1",
    external_ref: "MLB-25795",
    requesting_company_slug: "mlb",
    confidence: "high",
    status: "needs_review",
    extraction_json: {
      external_ref: "MLB-25795",
      client_name: "Jane Doe",
      site_address: "12 Smith Street Perth",
      makesafe_job_family: "general_makesafe",
    },
  };
  const report = summarizeGoldenReplay({
    emails: [CLEAN_WO],
    drafts: [draft],
    senderPatterns: MLB_PATTERNS,
    matchSender: senderMatchesPattern,
    rulesBySlug: mlbRules(true),
  });
  // template-first + full parse -> a model-skip candidate.
  assertEquals(report.counts.would_skip_model, 1);
  assertEquals(report.counts.would_call_model, 0);
  assertEquals(report.counts.pdf_text_path, 1);
  // template output matches the actual draft fields.
  assertEquals(report.counts.template_agreements, 1);
  assertEquals(report.counts.template_disagreements, 0);
  const item = report.items[0];
  assert(item.agreement.template_agreement);
  assertEquals(item.agreement.template_agreement!.agrees, true);
});

Deno.test("summary: template DISAGREEMENT with the actual draft is surfaced", () => {
  const draft: GoldenDraft = {
    graph_message_id: "post-mlb-1",
    external_ref: "MLB-25795",
    requesting_company_slug: "mlb",
    confidence: "high",
    status: "needs_review",
    // Actual draft has a DIFFERENT client than the template would parse.
    extraction_json: {
      external_ref: "MLB-25795",
      client_name: "Someone Else",
      site_address: "12 Smith Street Perth",
    },
  };
  const report = summarizeGoldenReplay({
    emails: [CLEAN_WO],
    drafts: [draft],
    senderPatterns: MLB_PATTERNS,
    matchSender: senderMatchesPattern,
    rulesBySlug: mlbRules(false),
  });
  assertEquals(report.counts.template_disagreements, 1);
  assertEquals(report.counts.template_agreements, 0);
  assert(report.items[0].agreement.notes.includes("template_disagrees_with_draft"));
});
