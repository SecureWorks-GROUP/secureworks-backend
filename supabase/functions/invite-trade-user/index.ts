import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTradeWelcomeEmail } from "./welcome_email.ts";

// Invites trade users queued in public.trade_invite_queue (admin-only table, RLS on, no client access).
// Callers cannot choose who gets invited: only rows an admin inserted via SQL are processed.
// No passwords are set; Supabase emails each invitee a link to set their own password.
//
// Straight after a successful invite the trade also gets the welcome email
// (welcome_email.ts): the steps in plain words and a link to the getting-started
// video. It goes once, in the same run that moves the row from pending to
// invited. If it cannot be sent the invite still stands: the row stays invited
// and its error column says the welcome email was not sent, so the office can
// send it by hand.
//
// This function was first deployed by hand on 4 Nov 2026 (live migration
// 20261104011518 trade_invite_queue made the table). It is in the repository
// from 11 Nov 2026 so a merge deploys it like every other function.
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const REDIRECT = "https://secureworks-group.github.io/secureworks-ux/trade.html";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rows, error } = await admin.from("trade_invite_queue").select("*").eq("status", "pending").limit(10);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const results: unknown[] = [];
  for (const r of rows ?? []) {
    const email = String(r.email).trim().toLowerCase();
    const inv = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: REDIRECT, data: { name: r.name } });
    if (inv.error || !inv.data?.user) {
      const msg = inv.error?.message ?? "no user returned";
      await admin.from("trade_invite_queue").update({ status: "error", error: msg, processed_at: new Date().toISOString() }).eq("id", r.id);
      results.push({ email, ok: false, error: msg });
      continue;
    }
    const uid = inv.data.user.id;
    const prof = await admin.from("users").upsert({ id: uid, org_id: ORG_ID, name: r.name, email, phone: r.phone, role: r.role ?? "crew", invoice_type: "hourly", trade_tier: 1, trade_sees_all_jobs: false }, { onConflict: "id" });
    if (prof.error) {
      await admin.from("trade_invite_queue").update({ status: "error", user_id: uid, error: prof.error.message, processed_at: new Date().toISOString() }).eq("id", r.id);
      results.push({ email, ok: false, user_id: uid, profile_error: prof.error.message });
      continue;
    }
    const welcome = await sendTradeWelcomeEmail(supabaseUrl, serviceKey, email, r.name);
    const welcomeError = welcome.ok ? null : `welcome email not sent: ${welcome.error}`;
    await admin.from("trade_invite_queue").update({ status: "invited", user_id: uid, error: welcomeError, processed_at: new Date().toISOString() }).eq("id", r.id);
    results.push({ email, ok: true, user_id: uid, welcome_email_sent: welcome.ok, welcome_email_error: welcome.ok ? undefined : welcome.error });
  }
  return Response.json({ ok: true, processed: results.length, results });
});
