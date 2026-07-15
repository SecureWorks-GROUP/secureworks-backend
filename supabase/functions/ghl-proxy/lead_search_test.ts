// Tests for the lead_search pure helpers (fence repeat-client mission).
//
// No network, no Supabase, no GHL. These exercise the merge/shape logic that
// index.ts feeds with mapped opps + Supabase cross-ref maps, plus the
// contactId-branch opportunity naming for create_contact_and_opportunity.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLeadSearchRows,
  createOpportunityForExistingContact,
  leadJobFallbackRows,
  leadOppNameForContact,
  matchesFirstWordRetry,
  scopeLeadJobQuery,
  type LeadContact,
  type LeadLookup,
  type LeadMappedOpp,
} from "./hardening_helpers.ts";

const FENCING = "I9t8njpuR0Dm7B2NDcvI";
const PATIO = "OGZLpPPVWVarN94HL6af";
const PIPELINES = { fencing: FENCING, patio: PATIO };

function mappedOpp(overrides: Partial<LeadMappedOpp> & { id: string }): LeadMappedOpp {
  return {
    name: "Opp",
    contactName: "Contact",
    contactEmail: "",
    contactPhone: "",
    contactAddress: "",
    contactCity: "",
    stageName: "New Lead",
    updatedAt: null,
    contactId: "",
    pipelineId: FENCING,
    ...overrides,
  };
}

Deno.test("buildLeadSearchRows: opp in requested pipeline becomes an opp row with cross-ref", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Jeff One", email: "jeff@x.com", phone: "0400", address: "1 St", city: "Perth" }];
  const lookups: Record<string, LeadLookup> = {
    c1: { opps: [mappedOpp({ id: "o1", contactId: "c1", updatedAt: "2026-02-01T00:00:00Z" })], failed: false },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: { o1: { id: "job-1", hasScope: true, jobNumber: "SWF-26001" } },
    jobByContactId: {},
  });

  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.id, "o1");
  assertEquals(r.contactId, "c1");
  assertEquals(r.isContactOnly, false);
  assertEquals(r.lookupFailed, false);
  assertEquals(r.supabaseJobId, "job-1");
  assertEquals(r.hasScope, true);
  assertEquals(r.jobNumber, "SWF-26001");
  // internal carry field must not leak into the row
  assertEquals((r as Record<string, unknown>).pipelineId, undefined);
});

Deno.test("buildLeadSearchRows: pipeline filtering drops other-pipeline opps → contact-only", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Jeff One" }];
  const lookups: Record<string, LeadLookup> = {
    c1: { opps: [mappedOpp({ id: "o1", contactId: "c1", pipelineId: PATIO })], failed: false },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: {},
    jobByContactId: {},
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].isContactOnly, true);
  assertEquals(rows[0].id, null);
  assertEquals(rows[0].lookupFailed, false);
});

Deno.test("buildLeadSearchRows: contact-id mismatch is dropped (AM-I no cross-client leak)", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Jeff One" }];
  const lookups: Record<string, LeadLookup> = {
    // opp belongs to a DIFFERENT contact — must not surface as c1's opp
    c1: { opps: [mappedOpp({ id: "o1", contactId: "someone-else" })], failed: false },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: { o1: { id: "job-leak", hasScope: true, jobNumber: "SWF-99999" } },
    jobByContactId: {},
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].isContactOnly, true);
  assertEquals(rows[0].id, null);
  // the leaked job must not appear
  assertEquals(rows[0].supabaseJobId, null);
});

Deno.test("buildLeadSearchRows: failed lookup degrades to a lookupFailed contact-only row, still contact cross-ref", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Jeff One", phone: "0400" }];
  const lookups: Record<string, LeadLookup> = {
    c1: { opps: [], failed: true },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: {},
    jobByContactId: { c1: { id: "job-c1", hasScope: false, jobNumber: "SWF-26010" } },
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].lookupFailed, true);
  assertEquals(rows[0].isContactOnly, true);
  assertEquals(rows[0].id, null);
  assertEquals(rows[0].supabaseJobId, "job-c1");
  assertEquals(rows[0].jobNumber, "SWF-26010");
});

Deno.test("buildLeadSearchRows: contact-only with a Supabase job by contact_id keeps isContactOnly true", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Jeff One" }];
  const lookups: Record<string, LeadLookup> = { c1: { opps: [], failed: false } };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: {},
    jobByContactId: { c1: { id: "job-c1", hasScope: true, jobNumber: "SWF-26011" } },
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].isContactOnly, true);
  assertEquals(rows[0].supabaseJobId, "job-c1");
  assertEquals(rows[0].hasScope, true);
});

Deno.test("buildLeadSearchRows: sort — opp rows by updatedAt desc, contact-only appended in search order", () => {
  const contacts: LeadContact[] = [
    { id: "cA", name: "A older opp" },
    { id: "cB", name: "B newer opp" },
    { id: "cC", name: "C no opp" },
    { id: "cD", name: "D no opp" },
  ];
  const lookups: Record<string, LeadLookup> = {
    cA: { opps: [mappedOpp({ id: "oA", contactId: "cA", updatedAt: "2026-01-01T00:00:00Z" })], failed: false },
    cB: { opps: [mappedOpp({ id: "oB", contactId: "cB", updatedAt: "2026-03-01T00:00:00Z" })], failed: false },
    cC: { opps: [], failed: false },
    cD: { opps: [], failed: false },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: {},
    jobByContactId: {},
  });

  assertEquals(rows.map((r) => r.id), ["oB", "oA", null, null]);
  // contact-only rows preserve contacts-search order (C before D)
  assertEquals(rows[2].contactId, "cC");
  assertEquals(rows[3].contactId, "cD");
});

Deno.test("buildLeadSearchRows: one contact with multiple valid opps yields a row per opp", () => {
  const contacts: LeadContact[] = [{ id: "c1", name: "Repeat client" }];
  const lookups: Record<string, LeadLookup> = {
    c1: {
      opps: [
        mappedOpp({ id: "o1", contactId: "c1", updatedAt: "2026-01-01T00:00:00Z" }),
        mappedOpp({ id: "o2", contactId: "c1", updatedAt: "2026-05-01T00:00:00Z" }),
      ],
      failed: false,
    },
  };
  const rows = buildLeadSearchRows({
    contacts,
    lookups,
    pipelineId: FENCING,
    jobByOppId: {},
    jobByContactId: {},
  });

  assertEquals(rows.map((r) => r.id), ["o2", "o1"]);
});

Deno.test("leadOppNameForContact: name built from FETCHED contact, not empty body", () => {
  // Body would have empty identity; the fetched contact is what names the opp.
  const fetched = { firstName: "Priya", lastName: "Nadar", phone: "0400111222", email: "p@x.com", address1: "9 Reef Rd" };
  assertEquals(leadOppNameForContact(fetched, "fencing"), "Priya Nadar — Fencing");
  assertEquals(leadOppNameForContact(fetched, "patio"), "Priya Nadar — Patio");
});

Deno.test("leadOppNameForContact: falls back to phone identity when name absent", () => {
  const fetched = { firstName: "", lastName: "", phone: "0400111222", email: "", address1: "" };
  assertEquals(leadOppNameForContact(fetched, "fencing"), "Phone lead 0400111222 — Fencing");
});

// ── create_contact_and_opportunity contactId branch (B2/AM-B) — mocked ghl ──

// Records every ghl() call so tests can assert what was / was not attempted.
function makeGhlMock(handlers: {
  contact?: (path: string) => any;
  opp?: (init: Record<string, unknown>) => any;
}) {
  const calls: { path: string; init?: Record<string, unknown> }[] = [];
  const ghl = (path: string, init?: Record<string, unknown>) => {
    calls.push({ path, init });
    if (path.startsWith("/contacts/")) {
      if (!handlers.contact) throw new Error("unexpected contact fetch");
      return Promise.resolve(handlers.contact(path));
    }
    if (path === "/opportunities/") {
      if (!handlers.opp) throw new Error("unexpected opportunity create");
      return Promise.resolve(handlers.opp(init || {}));
    }
    throw new Error(`unexpected ghl path ${path}`);
  };
  return { ghl, calls };
}

Deno.test("createOpportunityForExistingContact: contactId present → dedup/creation skipped, contact fetched, opp created with fetched-contact name", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => ({ contact: { id: "ct-1", firstName: "Priya", lastName: "Nadar", phone: "0400111222", email: "p@x.com", address1: "9 Reef Rd" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-1",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, { contactId: "ct-1", opportunityId: "opp-new", contactExisted: true });

  // exactly two calls: contact fetch then opportunity create — NO dedup search calls
  assertEquals(calls.length, 2);
  assertEquals(calls[0].path, "/contacts/ct-1");
  assertEquals(calls[1].path, "/opportunities/");

  // opp lands in the fencing pipeline, named from the FETCHED contact (not the body)
  const oppBody = JSON.parse(String(calls[1].init?.body));
  assertEquals(oppBody.pipelineId, FENCING);
  assertEquals(oppBody.contactId, "ct-1");
  assertEquals(oppBody.name, "Priya Nadar — Fencing");
});

Deno.test("createOpportunityForExistingContact: contact fetch 404 → contact_not_found 404 and NO opportunity creation attempted", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => {
      throw new Error("GHL 404: {\"message\":\"Contact not found\"}");
    },
    // opp handler omitted → any /opportunities/ call would throw "unexpected opportunity create"
  });

  const result = await createOpportunityForExistingContact({
    contactId: "missing",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 404);
  assertEquals(result.body, { error: "Contact not found", code: "contact_not_found" });

  // only the contact fetch was attempted — no opportunity creation
  assertEquals(calls.length, 1);
  assertEquals(calls[0].path, "/contacts/missing");
});

Deno.test("createOpportunityForExistingContact: non-404 fetch failure → contact_fetch_failed 502, no opp attempted", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => {
      throw new Error("GHL 500: upstream boom");
    },
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-err",
    toolType: "patio",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals((result.body as { code: string }).code, "contact_fetch_failed");
  assertEquals(calls.length, 1);
});

Deno.test("createOpportunityForExistingContact: opp creation failure → 500 echoing resolved contactId", async () => {
  const { ghl } = makeGhlMock({
    contact: () => ({ contact: { id: "ct-2", firstName: "Sam", lastName: "Lee" } }),
    opp: () => {
      throw new Error("GHL 422: bad pipeline");
    },
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-2",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 500);
  assertEquals(result.body.contactId, "ct-2");
  assertEquals(result.body.opportunityId, null);
  assertEquals(result.body.contactExisted, true);
});

Deno.test("createOpportunityForExistingContact: skipOpportunity → contact verified, no opp created", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => ({ contact: { id: "ct-3", firstName: "Dana", lastName: "Ruiz" } }),
    // opp handler omitted → any /opportunities/ call would throw "unexpected opportunity create"
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-3",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    skipOpportunity: true,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, { contactId: "ct-3", opportunityId: null, contactExisted: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].path, "/contacts/ct-3");
});

Deno.test("createOpportunityForExistingContact: skipOpportunity falsy → opportunity still created", async () => {
  const { ghl } = makeGhlMock({
    contact: () => ({ contact: { id: "ct-4", firstName: "Owen", lastName: "Pike" } }),
    opp: () => ({ opportunity: { id: "opp-4" } }),
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-4",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    skipOpportunity: false,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-4");
});

Deno.test("createOpportunityForExistingContact: 500 whose body says 'not found' → 502, not contact_not_found", async () => {
  const { ghl } = makeGhlMock({
    contact: () => {
      throw new Error('GHL 500: {"message":"Pipeline not found"}');
    },
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-5",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals((result.body as { code: string }).code, "contact_fetch_failed");
});

Deno.test("createOpportunityForExistingContact: 4xx whose body says 'not found' → contact_not_found 404", async () => {
  const { ghl } = makeGhlMock({
    contact: () => {
      throw new Error('GHL 422: {"message":"Contact not found"}');
    },
  });

  const result = await createOpportunityForExistingContact({
    contactId: "ct-6",
    toolType: "fencing",
    locationId: "loc-1",
    pipelines: PIPELINES,
    ghl,
  });

  assertEquals(result.status, 404);
  assertEquals((result.body as { code: string }).code, "contact_not_found");
});

Deno.test("matchesFirstWordRetry: keeps empty-lastName contact DEV-36 targets, drops unrelated same-first-name matches", () => {
  // "Louisa Webb" in GHL with an empty lastName — the miss DEV-36 exists to fix.
  assertEquals(matchesFirstWordRetry({ firstName: "Louisa", lastName: "" }, "Louisa Webb"), true);
  // full name contains the query
  assertEquals(matchesFirstWordRetry({ firstName: "Louisa", lastName: "Webb" }, "louisa webb"), true);
  // a different Louisa: firstName equals the first word → still kept (DEV-36 parity)
  assertEquals(matchesFirstWordRetry({ firstName: "Louisa", lastName: "Chen" }, "Louisa Webb"), true);
  // unrelated contact swept in by the broad first-word query → dropped
  assertEquals(matchesFirstWordRetry({ firstName: "Marco", lastName: "Louisano" }, "Louisa Webb"), false);
});

Deno.test("leadJobFallbackRows: jobs rows → contact-only lead Rows, deduped by contact id", () => {
  const rows = leadJobFallbackRows([
    { id: "job-1", client_name: "Louisa Webb", client_phone: "0400111222", client_email: "l@x.com", site_suburb: "Joondalup", ghl_contact_id: "ct-1", job_number: "SWF-26001", scope_json: { runs: [1] } },
    { id: "job-0", client_name: "Louisa Webb", ghl_contact_id: "ct-1", job_number: "SWF-25009", scope_json: {} },
    { id: "job-2", client_name: "Louisa Webber", ghl_contact_id: null, job_number: null, scope_json: null },
  ]);

  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    id: null,
    contactId: "ct-1",
    name: "Louisa Webb",
    contactName: "Louisa Webb",
    contactEmail: "l@x.com",
    contactPhone: "0400111222",
    contactAddress: "",
    contactCity: "Joondalup",
    stageName: "",
    updatedAt: null,
    supabaseJobId: "job-1",
    hasScope: true,
    jobNumber: "SWF-26001",
    isContactOnly: true,
    lookupFailed: false,
  });
  // no ghl contact id → still a contact-only row, contactId blank
  assertEquals(rows[1].contactId, "");
  assertEquals(rows[1].supabaseJobId, "job-2");
  assertEquals(rows[1].hasScope, false);
  assertEquals(rows[1].isContactOnly, true);
});

Deno.test("leadJobFallbackRows: row without a ghl contact id is marked lookupFailed", () => {
  const rows = leadJobFallbackRows([
    { id: "job-1", client_name: "Has Contact", ghl_contact_id: "ct-1", job_number: null, scope_json: null },
    { id: "job-2", client_name: "No Contact", ghl_contact_id: null, job_number: null, scope_json: null },
    { id: "job-3", client_name: "Blank Contact", ghl_contact_id: "", job_number: null, scope_json: null },
  ]);

  assertEquals(rows.map((r) => r.lookupFailed), [false, true, true]);
  assertEquals(rows.map((r) => r.contactId), ["ct-1", "", ""]);
});

function recordingQuery() {
  const calls: Array<[string, unknown]> = [];
  const query = {
    calls,
    eq(column: string, value: unknown) {
      calls.push([column, value]);
      return query;
    },
  };
  return query;
}

Deno.test("scopeLeadJobQuery: blank pipeline is not filtered on (would match no jobs)", () => {
  assertEquals(scopeLeadJobQuery(recordingQuery(), { orgScoped: true, orgId: "org-1", pipeline: "" }).calls, [
    ["org_id", "org-1"],
  ]);
  assertEquals(scopeLeadJobQuery(recordingQuery(), { orgScoped: true, orgId: "org-1", pipeline: undefined }).calls, [
    ["org_id", "org-1"],
  ]);
});

Deno.test("scopeLeadJobQuery: applies org and pipeline filters when both present", () => {
  assertEquals(scopeLeadJobQuery(recordingQuery(), { orgScoped: true, orgId: "org-1", pipeline: "fencing" }).calls, [
    ["org_id", "org-1"],
    ["type", "fencing"],
  ]);
});

Deno.test("scopeLeadJobQuery: shared-key callers are not org-filtered", () => {
  assertEquals(scopeLeadJobQuery(recordingQuery(), { orgScoped: false, orgId: "org-1", pipeline: "fencing" }).calls, [
    ["type", "fencing"],
  ]);
});

Deno.test("leadJobFallbackRows: array scope_json is not a scope (matches hasNonEmptyScope)", () => {
  const rows = leadJobFallbackRows([
    { id: "job-1", client_name: "Array Scope", ghl_contact_id: "ct-1", job_number: null, scope_json: [{ runs: 1 }] },
    { id: "job-2", client_name: "Object Scope", ghl_contact_id: "ct-2", job_number: null, scope_json: { runs: [1] } },
  ]);

  assertEquals(rows.map((r) => r.hasScope), [false, true]);
});
