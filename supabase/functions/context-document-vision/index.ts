// Vision reader door (gap plan B-5b; done-definition row 5 "Documents").
// Called by the Luna context worker (secureworks-jarvis) with the service key:
// "next" hands out one due scanned PDF or photo after reserving one call on
// the reader's shared daily budget, "submit" turns the model's answer into
// evidence. The model call itself happens in the worker, on the login the
// context reader already uses; this function calls no model. Off until
// feature flag context_document_vision_v1. JWT verification stays on.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
// deno-lint-ignore no-import-prefix
import { getDocumentProxy } from "npm:unpdf@1.6.2";
import { handleDocumentVision } from "./handler.ts";

async function pageCount(bytes: Uint8Array): Promise<number | null> {
  // deno-lint-ignore no-explicit-any
  let pdf: any = null;
  try {
    pdf = await getDocumentProxy(bytes.slice());
    const n = Number(pdf?.numPages || 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    try {
      await pdf?.destroy?.();
    } catch {
      // nothing to free
    }
  }
}

Deno.serve((req) =>
  handleDocumentVision(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      ),
    pageCount,
  })
);
