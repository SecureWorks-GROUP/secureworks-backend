// Tests for the M1.5 per-builder template parser (makesafe_template_parser.ts).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compareTemplateToActual,
  parseSubjectFields,
  parseWithTemplate,
  TEMPLATE_DEFAULT_REQUIRED,
  type TemplateParsingRules,
} from "./makesafe_template_parser.ts";

const MLB_RULES: TemplateParsingRules = {
  version: 1,
  template_first: true,
  confidence: "high",
  required: ["external_ref", "client_name", "site_address"],
  fields: {
    external_ref: { regex: "\\b(MLB[-\\s]?\\d{4,6})\\b", source: "all", group: 1, transform: "upper" },
    client_name: { regex: "Client:\\s*([A-Za-z ]+)", source: "all", group: 1, transform: "collapse_ws" },
    site_address: { regex: "Address:\\s*([0-9][^\\n]+)", source: "all", group: 1, transform: "collapse_ws" },
  },
};

const FULL_CTX = {
  subject: "NEW WORK ORDER MLB-25795 make safe",
  body: "Client: Jane Doe\nAddress: 12 Smith St Perth\nurgent",
  pdfText: "",
};

Deno.test("template FULL parse on a template-first builder -> model is skipped", () => {
  const r = parseWithTemplate(MLB_RULES, FULL_CTX)!;
  assert(r.full_parse, "expected a full parse");
  assertEquals(r.model_skipped, true);
  assertEquals(r.parser, "template");
  assertEquals(r.fields.external_ref, "MLB-25795");
  assertEquals(r.fields.client_name, "Jane Doe");
  assertEquals(r.fields.site_address, "12 Smith St Perth");
  assertEquals(r.confidence, "high");
});

Deno.test("PARTIAL parse (missing required field) falls back to the model", () => {
  const r = parseWithTemplate(MLB_RULES, { ...FULL_CTX, body: "Client: Jane Doe\nno address here" })!;
  assertEquals(r.full_parse, false);
  assertEquals(r.model_skipped, false);
  assertEquals(r.parser, "none");
  assertEquals(r.missing_required, ["site_address"]);
});

Deno.test("per-builder toggle DEFAULT-OFF: full parse but template_first=false STILL calls the model", () => {
  const offRules = { ...MLB_RULES, template_first: false };
  const r = parseWithTemplate(offRules, FULL_CTX)!;
  assert(r.full_parse, "the fields still parse");
  assertEquals(r.template_first, false);
  assertEquals(r.model_skipped, false); // toggle off -> never skip the model
});

Deno.test("template_first defaults to false when omitted from the rules", () => {
  const noToggle = { ...MLB_RULES };
  delete (noToggle as { template_first?: boolean }).template_first;
  const r = parseWithTemplate(noToggle, FULL_CTX)!;
  assertEquals(r.template_first, false);
  assertEquals(r.model_skipped, false);
});

Deno.test("empty / no-fields rules return null (builder has no template)", () => {
  assertEquals(parseWithTemplate(null, FULL_CTX), null);
  assertEquals(parseWithTemplate({}, FULL_CTX), null);
  assertEquals(parseWithTemplate({ template_first: true }, FULL_CTX), null);
});

Deno.test("a malformed regex in the rule data is a field miss, not a crash", () => {
  const bad: TemplateParsingRules = {
    template_first: true,
    fields: {
      external_ref: { regex: "(unclosed", source: "all" },
      client_name: MLB_RULES.fields!.client_name,
      site_address: MLB_RULES.fields!.site_address,
    },
  };
  const r = parseWithTemplate(bad, FULL_CTX)!;
  assertEquals(r.full_parse, false); // external_ref could not parse
  assert(r.missing_required.includes("external_ref"));
});

Deno.test("PDF-sourced fields are parsed from the extracted text layer", () => {
  const r = parseWithTemplate(MLB_RULES, {
    subject: "NEW WORK ORDER MLB-25795",
    body: "please attend",
    pdfText: "Client: John Smith\nAddress: 9 King Rd Perth",
  })!;
  assert(r.full_parse);
  assertEquals(r.fields.client_name, "John Smith");
});

Deno.test("compareTemplateToActual: agrees (normalised) vs disagrees", () => {
  const agree = compareTemplateToActual(
    { external_ref: "MLB-25795", client_name: "Jane Doe" },
    { external_ref: "MLB-25795", client_name: "jane  doe", site_address: null },
  );
  assertEquals(agree.agrees, true);
  assertEquals(agree.compared, 2);
  assertEquals(agree.per_field.external_ref, true);
  assertEquals(agree.per_field.client_name, true);
  assertEquals(agree.per_field.site_address, null); // actual missing -> nothing to compare

  const disagree = compareTemplateToActual(
    { client_name: "Jane Doe" },
    { client_name: "John Smith" },
  );
  assertEquals(disagree.agrees, false);
  assertEquals(disagree.per_field.client_name, false);
});

Deno.test("INVARIANT: template required set matches the intake required extraction fields", () => {
  // A template full-parse skip must not auto-file on fewer fields than the human gate.
  assertEquals(TEMPLATE_DEFAULT_REQUIRED, ["external_ref", "client_name", "site_address"]);
});

// ── UNIVERSAL SUBJECT PARSE (M1.5, runs for every builder before the model) ──
Deno.test("parseSubjectFields: lifts ref + address + suburb from a real builder subject", () => {
  const r = parseSubjectFields("NEW WORK ORDER - MLB-26499 18 Eagleglen Rise, Gidgegannup");
  assertEquals(r.external_ref, "MLB-26499");
  assertEquals(r.site_address, "18 Eagleglen Rise, Gidgegannup");
  assertEquals(r.site_suburb, "Gidgegannup");
});

Deno.test("parseSubjectFields: canonicalises a spaced ref to PREFIX-DIGITS uppercase", () => {
  assertEquals(parseSubjectFields("Make Safe mlb 26499 storm").external_ref, "MLB-26499");
  assertEquals(parseSubjectFields("AJBR-67200 Erskine make safe").external_ref, "AJBR-67200");
  assertEquals(parseSubjectFields("BWCWA 1234 fence").external_ref, "BWCWA-1234");
});

Deno.test("parseSubjectFields: street core captured, trailing postcode never gobbled", () => {
  // No comma before the suburb -> street core only (still better than null; the model
  // fills the suburb). The "WA 6000" postcode must not leak into the address.
  const r = parseSubjectFields("Work Order MLB-26500 - 5 Smith Street Perth WA 6000");
  assertEquals(r.external_ref, "MLB-26500");
  assertEquals(r.site_address, "5 Smith Street");
  assertEquals(r.site_suburb, null);
});

Deno.test("parseSubjectFields: no ref / no street address -> nulls (model fills)", () => {
  const r = parseSubjectFields("Photo evidence uploaded, please review");
  assertEquals(r.external_ref, null);
  assertEquals(r.site_address, null);
  assertEquals(r.site_suburb, null);
  // A bare number with no builder prefix must NOT be mistaken for a ref.
  assertEquals(parseSubjectFields("Job 12345 update").external_ref, null);
});
