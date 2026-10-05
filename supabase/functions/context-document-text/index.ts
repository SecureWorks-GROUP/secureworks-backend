// Document text reader (gap plan B-5; done-definition row 5 "Documents").
// Called every 10 minutes by pg_cron (trigger_context_document_text, only
// while feature flag context_document_text_v1 is on) with the service key.
// JWT verification stays on (the default deploy): only the service role is
// accepted, checked again in handler.ts. The run is read.ts; the PDF text
// layer extractor is make-safe intake's bounded one (no model is called).
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { extractPdfText } from "../ops-api/makesafe_pdf_text.ts";
import { handleDocumentText } from "./handler.ts";

Deno.serve((req) =>
  handleDocumentText(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      ),
    extract: extractPdfText,
    // EdgeRuntime is a Supabase-injected global. waitUntil(promise) keeps the
    // worker alive until the run settles after the 202 is returned.
    waitUntil: (p) => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    },
  })
);
