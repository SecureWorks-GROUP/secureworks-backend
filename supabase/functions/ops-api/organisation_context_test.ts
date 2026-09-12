import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { organisationContext } from "./organisation_context.ts";

Deno.test("organisation context is tenant-scoped and read-only", async () => {
  const orgId = "00000000-0000-4000-8000-0000000000aa";
  const facts = [{ id: "f1", org_id: orgId, kind: "note", value: { text: "hours" }, provenance: {} }];
  const client = {
    from(table: string) {
      const result = table === "organisations"
        ? { data: { id: orgId, name: "Org A" }, error: null }
        : { data: facts, error: null };
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(table === "organisations" ? result : { data: null, error: null }),
      };
      return q;
    },
  };
  const out = await organisationContext(client, { org_id: orgId });
  assertEquals(out.org_id, orgId);
  assertEquals(out.facts.length, 1);
  assertEquals(out.applicability, "companywide");
});
