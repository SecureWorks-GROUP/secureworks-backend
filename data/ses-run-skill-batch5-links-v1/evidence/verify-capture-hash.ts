// Read-only proof: does the d21ba19 fix make the two LIVE portal capture rows
// verify? Recomputes the reader's digest exactly as ses_assembler_input_adapter
// does (persistedCaptureContent -> sesPortalCaptureRevisionHash) and compares to
// the stored makesafe_content_hash. Touches nothing.
import { sesPortalCaptureRevisionHash } from "../../../supabase/functions/ops-api/ses_portal_capture_contract.ts";
const rows = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const F = ["job_id","attendance_cycle_id","role","capture_result","source_url","source_content_hash",
  "builder_reference","captured_at","captured_by","capture_producer","capture_idempotency_key","signal",
  "screenshot_object_key","screenshot_media_type","screenshot_content_hash","screenshot_size_bytes"];
for (const r of rows) {
  const content: any = {};
  for (const f of F) content[f] = r[f];
  // PostgREST spells timestamptz as the reader sees it; the DB query above returns
  // "2026-08-02 15:52:16+00". Test BOTH plausible read-back spellings.
  const spellings = [r.captured_at, String(r.captured_at).replace(" ", "T").replace("+00", "+00:00")];
  for (const s of spellings) {
    const digest = await sesPortalCaptureRevisionHash({ ...content, captured_at: s });
    console.log(`${r.job_number}  spelling="${s}"  match=${digest === r.makesafe_content_hash}`);
  }
}
