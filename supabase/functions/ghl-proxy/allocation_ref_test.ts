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
  readCreateAllocationRef,
  readLookupAllocationQuery,
} from "./allocation_ref.ts";
import { createOpportunityForExistingContact } from "./hardening_helpers.ts";
import { GhlProviderReadError } from "./provider_reads.ts";

const FIELD_ID = "cf_stratco_alloc";
const REF = "229818";
const CONTACT = "ct-1";
const FENCING = "I9t8njpuR0Dm7B2NDcvI";
const PIPELINES = { fencing: FENCING, patio: "OGZLpPPVWVarN94HL6af" };

function makeGhlMock(handlers: {
  search?: (path: string, init?: Record<string, unknown>) => any;
  getOpp?: (path: string) => any;
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
    if (path === "/opportunities/") {
      if (!handlers.opp) throw new Error("unexpected opportunity create");
      return Promise.resolve(handlers.opp(init || {}));
    }
    if (path.startsWith("/opportunities/")) {
      if (!handlers.getOpp) throw new Error("unexpected opportunity get");
      return Promise.resolve(handlers.getOpp(path));
    }
    if (path.startsWith("/contacts/")) {
      if (!handlers.contact) throw new Error("unexpected contact fetch");
      return Promise.resolve(handlers.contact(path));
    }
    throw new Error(`unexpected ghl path ${path}`);
  };
  return { ghl, calls };
}

function existingOpp(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-existing",
    contactId: CONTACT,
    customFields: [{ id: FIELD_ID, fieldValue: REF }],
    ...overrides,
  };
}

function otherHydratedOpp(id: string) {
  return {
    id,
    contactId: CONTACT,
    customFields: [{ id: "other", fieldValue: "x" }],
  };
}

function searchPathHasContactAndAllStatus(path: string): boolean {
  return path.startsWith("/opportunities/search") &&
    path.includes(`contactId=${CONTACT}`) &&
    path.includes("status=all") &&
    !path.includes("q=");
}

async function createWithOptionalRef(args: {
  body: Record<string, unknown>;
  fieldId: string | null;
  ghl: (path: string, init?: Record<string, unknown>) => Promise<any>;
  skipOpportunity?: unknown;
  contactJustCreated?: boolean;
}) {
  const parsed = readCreateAllocationRef(args.body);
  if (parsed) {
    const prepared = await prepareAllocationCreate({
      ref: parsed,
      fieldId: args.fieldId,
      locationId: "loc-1",
      contactId: String(args.body.contactId ?? ""),
      contactJustCreated: args.contactJustCreated === true,
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

Deno.test("create and lookup readers keep allocationRef and contactId only", () => {
  assertEquals(readCreateAllocationRef({ allocationRef: REF }), REF);
  assertEquals(readCreateAllocationRef({ allocationRef: `stratco-allocation:${REF}` }), REF);
  assertEquals(readCreateAllocationRef({ allocation_ref: REF }), null);
  assertEquals(readCreateAllocationRef({ stratcoAllocationRef: REF }), null);
  const params = new URLSearchParams({ allocationRef: REF, contactId: CONTACT });
  assertEquals(readLookupAllocationQuery(params), { ref: REF, contactId: CONTACT });
  const aliased = new URLSearchParams({ ref: REF, contact_id: CONTACT });
  assertEquals(readLookupAllocationQuery(aliased), { ref: null, contactId: null });
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
    contact: () => ({ contact: { id: CONTACT, firstName: "Priya", lastName: "Nadar" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing" },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, { contactId: CONTACT, opportunityId: "opp-new", contactExisted: true });
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
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, {
    contactId: CONTACT,
    opportunityId: "opp-existing",
    contactExisted: true,
    opportunityExisted: true,
  });
  assertEquals(calls.length, 1);
  assertEquals(searchPathHasContactAndAllStatus(calls[0].path), true);
});

Deno.test("hydrated non-matching customFields on a short page is none found and creates once", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [otherHydratedOpp("opp-other")] }),
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(calls.filter((c) => c.path.startsWith("/opportunities/search")).length, 1);
  assertEquals(calls.filter((c) => c.path.startsWith("/opportunities/") && c.path !== "/opportunities/" && !c.path.startsWith("/opportunities/search")).length, 0);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
});

Deno.test("reference and none found creates once with the allocation custom field", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [] }),
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: `stratco-allocation:${REF}` },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(result.body.opportunityExisted, undefined);
  assertEquals(searchPathHasContactAndAllStatus(calls[0].path), true);
  assertEquals(calls.map((c) => c.path), [
    calls[0].path,
    "/contacts/ct-1",
    "/opportunities/",
  ]);
  const oppBody = JSON.parse(String(calls[2].init?.body));
  assertEquals(oppBody.customFields, [{ id: FIELD_ID, field_value: REF }]);
  assertEquals(oppBody.contactId, CONTACT);
  assertEquals(oppBody.name.includes(REF), false);
});

Deno.test("retry after a successful create returns the existing opportunity and creates nothing", async () => {
  const created: unknown[] = [];
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: created }),
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: (init) => {
      const body = JSON.parse(String(init.body));
      const opp = {
        id: "opp-new",
        contactId: CONTACT,
        customFields: [{ id: FIELD_ID, fieldValue: body.customFields[0].field_value }],
      };
      created.push(opp);
      return { opportunity: opp };
    },
  });

  const first = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });
  const createCalls = calls.filter((c) => c.path === "/opportunities/").length;
  const second = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(first.status, 200);
  assertEquals(first.body.opportunityId, "opp-new");
  assertEquals(createCalls, 1);
  assertEquals(second.status, 200);
  assertEquals(second.body, {
    contactId: CONTACT,
    opportunityId: "opp-new",
    contactExisted: true,
    opportunityExisted: true,
  });
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
  assertEquals(calls.every((c) => !c.path.startsWith("/opportunities/search") || searchPathHasContactAndAllStatus(c.path)), true);
});

Deno.test("unhydrated list row missing customFields triggers a by-id read", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [{ id: "opp-1", contactId: CONTACT }] }),
    getOpp: () => ({
      opportunity: { id: "opp-1", contactId: CONTACT, customFields: [] },
    }),
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(calls.some((c) => c.path === "/opportunities/opp-1"), true);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
});

Deno.test("unhydrated empty customFields array triggers a by-id read", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [{ id: "opp-1", contactId: CONTACT, customFields: [] }] }),
    getOpp: () => ({
      opportunity: existingOpp({ id: "opp-1" }),
    }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body, {
    contactId: CONTACT,
    opportunityId: "opp-1",
    contactExisted: true,
    opportunityExisted: true,
  });
  assertEquals(calls.map((c) => c.path), [calls[0].path, "/opportunities/opp-1"]);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 0);
});

Deno.test("by-id read failure refuses create", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => ({ opportunities: [{ id: "opp-1", contactId: CONTACT }] }),
    getOpp: () => {
      throw new Error("GHL 500: upstream boom");
    },
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
  assertEquals(calls.some((c) => c.path === "/opportunities/opp-1"), true);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 0);
});

Deno.test("pagination beyond one page is fully read before certifying absence", async () => {
  const { ghl, calls } = makeGhlMock({
    search: (path) => {
      if (!path.includes("startAfter=")) {
        return {
          opportunities: Array.from({ length: 100 }, (_, i) => otherHydratedOpp(`opp-${i}`)),
          meta: { startAfter: "cursor-1", startAfterId: "opp-99" },
        };
      }
      return { opportunities: [otherHydratedOpp("opp-tail")] };
    },
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  const searches = calls.filter((c) => c.path.startsWith("/opportunities/search"));
  assertEquals(searches.length, 2);
  assertEquals(searches[1].path.includes("startAfter=cursor-1"), true);
  assertEquals(searches[1].path.includes("startAfterId=opp-99"), true);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
});

Deno.test("a full unmatched page with no cursor is truncated and refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({
      search: () => ({
        opportunities: Array.from({ length: 100 }, (_, i) => otherHydratedOpp(`opp-${i}`)),
      }),
    }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("failed lookup refuses create", async () => {
  const { ghl, calls } = makeGhlMock({
    search: () => {
      throw new Error("GHL 500: upstream boom");
    },
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
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
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl,
  });

  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 0);
});

Deno.test("malformed lookup (opportunities not an array) refuses create", async () => {
  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    ghl: makeGhlMock({ search: () => ({ opportunities: { id: "x" } }) }).ghl,
  });
  assertEquals(result.status, 502);
  assertEquals(result.body.code, "allocation_lookup_unreadable");
});

Deno.test("contact created in this call with no prior opportunities is proven empty", async () => {
  const { ghl, calls } = makeGhlMock({
    contact: () => ({ contact: { id: CONTACT, firstName: "Stewart", lastName: "Thorpe" } }),
    opp: () => ({ opportunity: { id: "opp-new" } }),
  });

  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: FIELD_ID,
    contactJustCreated: true,
    ghl,
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.opportunityId, "opp-new");
  assertEquals(calls.filter((c) => c.path.startsWith("/opportunities/search")).length, 0);
  assertEquals(calls.filter((c) => c.path === "/opportunities/").length, 1);
  const oppBody = JSON.parse(String(calls[1].init?.body));
  assertEquals(oppBody.customFields, [{ id: FIELD_ID, field_value: REF }]);
});

Deno.test("unconfigured field id refuses and creates nothing", async () => {
  const { ghl, calls } = makeGhlMock({});
  const result = await createWithOptionalRef({
    body: { contactId: CONTACT, toolType: "fencing", allocationRef: REF },
    fieldId: null,
    ghl,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.code, "allocation_field_unconfigured");
  assertEquals(String(result.body.error).includes(ALLOCATION_FIELD_ENV), true);
  assertEquals(calls.length, 0);
});

Deno.test("lookup action: found / not found / unconfigured / unreadable / missing contact", async () => {
  const found = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    contactId: CONTACT,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({ opportunities: [existingOpp()] }) }).ghl,
  });
  assertEquals(found, {
    status: 200,
    body: { found: true, opportunityId: "opp-existing", contactId: CONTACT },
  });

  const missing = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    contactId: CONTACT,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({ opportunities: [] }) }).ghl,
  });
  assertEquals(missing, {
    status: 200,
    body: { found: false, opportunityId: null, contactId: CONTACT },
  });

  const unconfigured = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    contactId: CONTACT,
    fieldId: null,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(unconfigured.status, 400);
  assertEquals(unconfigured.body.code, "allocation_field_unconfigured");

  const unreadable = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    contactId: CONTACT,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({ search: () => ({}) }).ghl,
  });
  assertEquals(unreadable.status, 502);
  assertEquals(unreadable.body.code, "allocation_lookup_unreadable");
  assertEquals(unreadable.body.found, undefined);

  const noContact = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: REF,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(noContact.status, 400);
  assertEquals(noContact.body.code, "allocation_contact_required");
  assertEquals(noContact.body.found, undefined);
});

Deno.test("lookup action is GET only and requires a reference", async () => {
  const method = await lookupAllocationOpportunityAction({
    method: "POST",
    ref: REF,
    contactId: CONTACT,
    fieldId: FIELD_ID,
    locationId: "loc-1",
    ghl: makeGhlMock({}).ghl,
  });
  assertEquals(method.status, 405);
  assertEquals(method.body.code, "method_not_allowed");

  const missingRef = await lookupAllocationOpportunityAction({
    method: "GET",
    ref: "  ",
    contactId: CONTACT,
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
        contactId: CONTACT,
      }),
    GhlProviderReadError,
  );
  assertEquals(thrown, rateLimited);
});
