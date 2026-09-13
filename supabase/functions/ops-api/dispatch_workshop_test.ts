import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readDispatchJobWorkshop } from "./dispatch_workshop.ts";

const ORG = "00000000-0000-4000-8000-000000000001";

Deno.test("workshop reader does not require an AI assessor", async () => {
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assertEquals(name, "read_dispatch_job_workshop");
      assertEquals(args.p_job_id, "job-1");
      assertEquals(args.p_po_id, null);
      return {
        data: { ai_assessor_required: false, grounding: { notes: [{ text: "kept" }] } },
        error: null,
      };
    },
  };
  const out = await readDispatchJobWorkshop(
    client,
    { job_id: "job-1" },
    { mode: "jwt", user: { id: "user-1", orgId: ORG } },
    ORG,
  );
  assertEquals(out.ai_assessor_required, false);
  assertEquals(out.grounding.notes[0].text, "kept");
});
