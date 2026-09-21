// Allocation-ref lookup and create-with-field. Mocked GHL only — no live provider.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALLOCATION_FIELD_ENV,
  allocationOpportunityCustomFields,
  lookupAllocationOpportunityAction,
  lookupOpportunityByAllocationRef,
  opportunityCarriesAllocationRef,
  parseAllocationReference,
  parseOpportunitySearchResponse,
  prepareAllocationCreate,
  readAllocationFieldId,
} from "./allocation_ref.ts";
import { createOpportunityForExistingContact } from "./hardening_helpers.ts";
import { GhlProviderReadError } from "./provider_reads.ts";

const FIELD_ID = "cf_stratco_alloc";
const REF = "229818";
const FENCING = "I9t8njpuR0Dm7B2NDcvI";
const PIPELINES = { fencing: FENCING, patio: "OGZLpPPVWVarN94HL6af" };

function makeGhlMock(handlers: {
  search?: (path: string, init?: Record<string, unknown>) => any;
  contact?: (path: string) => any;
  opp?: (init: Record<string, unknown>) => any;
}) {
  const calls: { path: string; init?: Record<string, unknown> }[] = [];
  const ghl = (path: string, init?: Record<string, unknown>) => {
    calls.push({ path, init });
    if (path.startsWith("/opportunities/search")) {
      if (!handlers.search) throw new Error("unexpected opportunity search");
      return Promise.resolve(handlers.search(path, init));
    }
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

function existingOpp(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-existing",
    contactId: "ct-existing",
    customFields: [{ id: FIELD_ID, fieldValue: REF }],
    ...overrides,
  };
}

async function createWithOptionalRef(args: {
  body: Record<string, unknown>;
  fieldId: string | null;
  ghl: (path: string, init?: Record<string, unknown>) => Promise<any>;
  skipOpportunity?: unknown;
}) {
  const parsed = parseAllocationReference(args.body.allocationRef);
  if (parsed) {
    const prepared = await prepareAllocationCreate({
      ref: parsed,
      fieldId: args.fieldId,
      locationId: "loc-1",
      ghl: args.ghl,
    });
    if (prepared.kind !== "create") {
      return { status: prepared.status, body: prepared.body };
    }
    return createOpportunityForExistingContact({
      contactId: String(args.body.contactId),
      toolType: args.body.toolType,
      locationId: "loc-1",
      pipelines: PIPELINES,
      skipOpportunity: args.skipOpportunity,
      customFields: allocationOpportunityCustomFields(prepared.fieldId, prepared.ref),
      ghl: args.ghl,
    });
  }
  return createOpportunityForExistingContact({
    contactId: String(args.body.contactId),
    toolType: args.body.toolType,
    locationId: "loc-1",
    pipelines: PIPELINES,
    skipOpportunity: args.skipOpportunity,
    ghl: args.ghl,
  });
}

Deno.test("parseAllocationReference strips the retry-key prefix and ignores blanks", () => {
  assertEquals(parseAllocationReference(undefined), null);
  assertEquals(parseAllocationReference(""), null);
  assertEquals(parseAllocationReference("   "), null);
  assertEquals(parseAllocationReference("  229818  "), "229818");
  assertEquals(parseAllocationReference("stratco-allocation:229818"), "229818");
  assertEquals(parseAllocationReference(229818), "229818");
});

Deno.test("readAllocationFieldId uses the one env name and treats blank as unconfigured", () => {
  assertEquals(readAllocationFieldId(() => undefined), null);
  assertEquals(readAllocationFieldId(() => "  "), null);
  assertEquals(readAllocationFieldId((name) => name === ALLOCATION_FIELD_ENV ? FIELD_ID : undefined), FIELD_ID);
});

Deno.test("opportunityCarriesAllocationRef matches id plus fieldValue/field_value/value", () => {
  assertEquals(
    opportunityCarriesAllocationRef({ customFields: [{ id: FIELD_ID, fieldValue: REF }] }, FIELD_ID, REF),
    true,
  );
  assertEquals(
    opportunityCarriesAllocationRef({ customFields: [{ id: FIELD_ID, field_value: REF }] }, FIELD_ID, REF),
    true,
  );
  assertEquals(
    opportunityCarriesAllocationRef({ customFields: [{ id: FIELD_ID, value: REF }] }, FIELD_ID, REF),
    true,
  );
  assertEquals(
    opportunityCarriesAllocationRef({ customFields: [{ id: "other", fieldValue: REF }] }, FIELD_ID, REF),
    false,
  );
  assertEquals(opportunityCarriesAllocationRef({ customFields: [] }, FIELD_ID, REF), false);
  assertEquals(opportunityCarriesAllocationRef({}, FIELD_ID, REF), false);
});

Deno.test("parseOpportunitySearchResponse refuses missing or non-array opportunities", () => {
  assertEquals(parseOpportunitySearchResponse({ opportunities: [] }), { ok: true, opportunities: [] });
  assertEquals(parseOpportunitySearchResponse({}), { ok: false });
  assertEquals(parseOpportunitySearchResponse({ opportunities: null }), { ok: false });
  assertEquals(parseOpportunitySearchResponse({ opportunities: {} }), { ok: false });
  assertEquals(parseOpportunitySearchResponse(null), { ok: false });
});

Deno.test("no allocationRef leaves createOpportunityForExistingContact unchanged: no search, no customFields", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => ({ contact: { id: "ct-1", firstName: "Priya", lastName: "Nadar" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing" },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, { contactId: "ct-1", opportunityId: "opp-new", contactExisted: true });
  assertEquals(calls.map((c) => c.path), ["/contacts/ct-1", "/opportunities/"]);
  const oppBody = JSON.parse(String(calls[1].init?.body));
  assertEquals(oppBody.customFields, undefined);
  assertEquals(oppBody.pipelineId, FENCING);
  assertEquals(oppBody.name, "Priya Nadar — Fencing");
});

Deno.test("reference plus existing opportunity returns it and creates nothing", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [existingOpp()] }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, {
    contactId: "ct-existing",
    opportunityId: "opp-existing",
    contactExisted: true,
    opportunityExisted: true,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].path.startsWith("/opportunities/search"), true);
  assertEquals(calls[0].path.includes(`q=${REF}`), true);
  assertEquals(calls[0].path.includes("status=all"), true);
});

Deno.test("a short page of readable non-matching customFields is none found and creates once", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [{ id: "opp-other", customFields: [] }] }),
    contact: () => ({ contact: { id: "ct-1", firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
});

Deno.test("reference and none found creates once with the allocation custom field", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [] }),
    contact: () => ({ contact: { id: "ct-1", firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: `stratco-allocation:${REF}` },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(result.body.opportunityExisted, undefined);
  assertEquals(calls.map((c) => c.path.startsWith("/opportunities/search") || c.path), [
    true,
    "/contacts/ct-1",
    "/opportunities/",
  ]);
  const oppBody = JSON.parse(String(calls[2].init?.body));
  assertEquals(oppBody.customFields, [{ id: FIELD_ID, field_value: REF }]);
  assertEquals(oppBody.contactId, "ct-1");
});

Deno.test("retry of the same reference creates nothing", async () => {
  const created: unknown[] = [];
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: created }),
    contact: () => ({ contact: { id: "ct-1", firstName: "Stewart", lastName: "Thorpe" } }),
    opp: (init) => {
      const body = JSON.parse(String(init.body));
      const opp = {
        id: "opp-new",
        contactId: "ct-1",
        customFields: [{ id: FIELD_ID, fieldValue: body.customFields[0].field_value }],
      };
      created.push(opp);
      return { opportunity: opp };
    },
  });

  const first = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });
  const createCalls = calls.filter((c) => c.path === "/opportunities/").length;
  const second = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(first.status, 200);
  assertEquals(first.body.opportunityId, "opp-new");
  assertEquals(createCalls, 1);
  assertEquals(second.status, 200);
  assertEquals(second.body, {
    contactId: "ct-1",
    opportunityId: "opp-new",
    contactExisted: true,
    opportunityExisted: true,
  });
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
});

Deno.test("failed lookup refuses create", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => {
      throw new Error("GHL 500: upstream boom");
    },
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 0);
  assertEquals(calls.filter((c) => c.path.startsWith("/contacts/")).length, 0);
});

Deno.test("malformed lookup (missing opportunities array) refuses create", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ meta: { total: 0 } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 0);
});

Deno.test("malformed lookup (opportunities not an array) refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({ search: () => ({ opportunities: { id: "x" } }) }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("unreadable customFields on a search row refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({
      search: () => ({ opportunities: [{ id: "opp-1", customFields: "nope" }] }),
    }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("a search row that omits customFields is unreadable and refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({
      search: () => ({ opportunities: [{ id: "opp-1" }] }),
    }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("a matching row still wins when a sibling omits customFields", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({
      search: () => ({ opportunities: [{ id: "opp-other" }, existingOpp()] }),
    }).ghl,
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-existing");
  assertEquals(result.body.opportunityExisted, true);
});

Deno.test("a full unmatched search page is unproven absence and refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({
      search: () => ({
        opportunities: Array.from({ length: 100 }, (_, i) => ({ id: `opp-${i}` })),
      }),
    }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("unconfigured field id refuses and creates nothing", async () => {
  const { ghl, calls } = makeGhlMock({});
  const result = await createWithOptionalRef({
    body: { contactId: "ct-1", toolType: "fencing", allocationRef: REF },
    fieldId: null,
    ghl,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.code, "allocation_field_unconfigured");
  assertEquals(String(result.body.error).includes(ALLOCATION_FIELD_ENV), true);
  assertEquals(calls.length, 0);
});

Deno.test("lookup action: found / not found / unconfigured / unreadable", async () => {
  const found = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({ opportunities: [existingOpp()] }) }).ghl,
  });
  assertEquals(found, {
    status: 200,
    body: { found: true, opportunityId: "opp-existing", contactId: "ct-existing" },
  });

  const missing = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({ opportunities: [] }) }).ghl,
  });
  assertEquals(missing, {
    status: 200,
    body: { found: false, opportunityId: null, contactId: null },
  });

  const unconfigured = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    fieldId: null,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(unconfigured.status, 400);
  assertEquals(unconfigured.body.code, "allocation_field_unconfigured");

  const unreadable = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({}) }).ghl,
  });
  assertEquals(unreadable.status, 502);
  assertEquals(unreadable.body.code, "allocation_lookup_unreadable");
  assertEquals(unreadable.body.found, false);
});

Deno.test("lookup action is GET only and requires a reference", async () => {
  const method = await lookupAllocationOpportunityAction({
    method: "POST",
    ref: REF,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(method.status, 405);
  assertEquals(method.body.code, "method_not_allowed");

  const missingRef = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: "  ",
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(missingRef.status, 400);
  assertEquals(missingRef.body.code, "allocation_ref_required");
});

Deno.test("lookup 429 is rethrown so the proxy can emit HTTP 429", async () => {
  const rateLimited = new GhlProviderReadError(
    "ghl_rate_limited",
    "GHL 429: slow down",
    429,
    429,
    "12",
  );
  const thrown = await assertRejects(
    () =>
      lookupOpportunityByAllocationRef({
        ghl: () => Promise.reject(rateLimited),
        locationId: "loc-1",
        fieldId: FIELD_ID,
        ref: REF,
      }),
    GhlProviderReadError,
  );
  assertEquals(thrown, rateLimited);
});
