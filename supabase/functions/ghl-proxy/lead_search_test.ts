// Tests for the lead_search pure helpers (fence repeat-client mission).
//
// No network, no Supabase, no GHL. These exercise the merge/shape logic that
// index.ts feeds with mapped opps + Supabase cross-ref maps, plus the
// contactId-branch opportunity naming for create_contact_and_opportunity.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLeadSearchRows,
  leadOppNameForContact,
  type LeadContact,
  type LeadLookup,
  type LeadMappedOpp,
} from "./hardening_helpers.ts";

const FENCING = "I9t8njpuR0Dm7B2NDcvI";
const PATIO = "OGZLpPPVWVarN94HL6af";

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
