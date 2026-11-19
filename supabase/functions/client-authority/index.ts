// ════════════════════════════════════════════════════════════
// SecureWorks — client authority, signed from a texted link
//
// JWT flag: --no-verify-jwt (public: the property owner opens the link on their
// phone with no account; the random token in the link is the only key).
//
//   GET  ?t=<token>                       the wording and the job it is for
//   POST {t, signed_name, signature, agree: true}
//                                         signs it: a PDF with the wording, the
//                                         drawn signature, time, IP and browser
//                                         is filed on the job, office only
//
// The office opens one with ops-api client_authority_create. Contract and
// wording: _shared/client_authority.ts. Nothing here sends a message.
// ════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AUTHORITY_WORDINGS,
  CLIENT_AUTHORITY_DOC_KIND,
  decodeSignaturePng,
  perthStamp,
  renderSignedAuthorityPdf,
  sha256Hex,
  wordingText,
} from "../_shared/client_authority.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "job-documents";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

async function findAuthority(sb: any, token: string) {
  const { data, error } = await sb.from("job_documents")
    .select("id, job_id, metadata, pdf_url, accepted_at")
    .eq("metadata->>kind", CLIENT_AUTHORITY_DOC_KIND)
    .eq("metadata->>authority_token", token)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`lookup failed: ${error.message}`);
  return data;
}

async function jobFacts(sb: any, jobId: string) {
  const { data: job } = await sb.from("jobs").select("job_number, site_address, site_suburb").eq("id", jobId).maybeSingle();
  const { data: detail } = await sb.from("makesafe_job_details").select("external_ref").eq("job_id", jobId).maybeSingle();
  const address = [job?.site_address, job?.site_suburb]
    .filter((p: unknown) => typeof p === "string" && p.trim())
    .filter((p: string, i: number, all: string[]) => i === 0 || !all[0].toLowerCase().includes(p.toLowerCase()))
    .join(", ");
  return { job_number: job?.job_number || "", site_address: address, builder_reference: detail?.external_ref ? String(detail.external_ref).replace(/(\S)PO-/, "$1 / PO-") : null };
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  try {
    if (req.method === "GET") {
      const token = new URL(req.url).searchParams.get("t") || "";
      if (!TOKEN.test(token)) return json({ ok: false, code: "link_invalid", error: "This link is not valid." }, 400);
      const doc = await findAuthority(sb, token);
      if (!doc) return json({ ok: false, code: "link_invalid", error: "This link is not valid." }, 404);
      const m = doc.metadata || {};
      const wording = AUTHORITY_WORDINGS[m.wording_version];
      if (!wording) return json({ ok: false, code: "wording_missing", error: "This form can no longer be shown. Please call us." }, 410);
      const facts = await jobFacts(sb, doc.job_id);
      const signed = m.client_authority === "signed";
      const expired = !signed && m.expires_at && Date.parse(m.expires_at) < Date.now();
      return json({
        ok: true,
        status: signed ? "signed" : expired ? "expired" : "pending",
        job_number: facts.job_number,
        site_address: facts.site_address,
        builder_reference: facts.builder_reference,
        signer_name: m.signer_name || null,
        signed_name: signed ? m.signed_name || null : null,
        signed_at: signed ? m.signed_at || null : null,
        wording,
      });
    }

    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const token = typeof body.t === "string" ? body.t : "";
    if (!TOKEN.test(token)) return json({ ok: false, code: "link_invalid", error: "This link is not valid." }, 400);
    const signedName = typeof body.signed_name === "string" ? body.signed_name.trim().slice(0, 120) : "";
    if (signedName.length < 2) return json({ ok: false, code: "name_required", error: "Please type your full name." }, 400);
    if (body.agree !== true) return json({ ok: false, code: "agree_required", error: "Please tick that you have read and agree." }, 400);
    const signature = decodeSignaturePng(body.signature);
    if (!signature) return json({ ok: false, code: "signature_required", error: "Please draw your signature." }, 400);

    const doc = await findAuthority(sb, token);
    if (!doc) return json({ ok: false, code: "link_invalid", error: "This link is not valid." }, 404);
    const m = doc.metadata || {};
    if (m.client_authority === "signed") return json({ ok: true, status: "signed", already_signed: true, signed_at: m.signed_at || null });
    if (m.expires_at && Date.parse(m.expires_at) < Date.now()) {
      return json({ ok: false, code: "link_expired", error: "This link has expired. Please ask us for a new one." }, 410);
    }
    const wording = AUTHORITY_WORDINGS[m.wording_version];
    if (!wording) return json({ ok: false, code: "wording_missing", error: "This form can no longer be signed. Please call us." }, 410);
    const wordingSha = await sha256Hex(wordingText(wording));
    if (m.wording_sha256 && m.wording_sha256 !== wordingSha) {
      return json({ ok: false, code: "wording_changed", error: "This form has changed. Please ask us for a new link." }, 409);
    }

    const facts = await jobFacts(sb, doc.job_id);
    const signedAt = new Date().toISOString();
    const ip = clientIp(req);
    const ua = (req.headers.get("user-agent") || "").slice(0, 400) || null;
    const pdf = await renderSignedAuthorityPdf({
      job_number: facts.job_number,
      site_address: facts.site_address,
      builder_reference: facts.builder_reference,
      signer_name: signedName,
      signer_phone: m.signer_phone || null,
      signed_at_iso: signedAt,
      signed_at_perth: perthStamp(signedAt),
      ip,
      user_agent: ua,
      wording,
      wording_sha256: wordingSha,
      signature_png: signature,
    });
    const pdfSha = await sha256Hex(pdf);
    const folder = `${doc.job_id}/client-authority/${doc.id}`;
    const pdfPath = `${folder}/Client_authority_${facts.job_number || "job"}_signed.pdf`;
    const sigPath = `${folder}/signature.png`;
    const up1 = await sb.storage.from(BUCKET).upload(sigPath, signature, { contentType: "image/png", upsert: true });
    if (up1.error) throw new Error(`signature upload failed: ${up1.error.message}`);
    const up2 = await sb.storage.from(BUCKET).upload(pdfPath, pdf, { contentType: "application/pdf", upsert: true });
    if (up2.error) throw new Error(`pdf upload failed: ${up2.error.message}`);
    const pdfUrl = sb.storage.from(BUCKET).getPublicUrl(pdfPath).data.publicUrl;

    const metadata = {
      ...m,
      client_authority: "signed",
      signed_name: signedName,
      signed_at: signedAt,
      signed_ip: ip,
      signed_user_agent: ua,
      signature_path: sigPath,
      pdf_path: pdfPath,
      pdf_sha256: pdfSha,
      wording_sha256: wordingSha,
    };
    const { data: updated, error: upErr } = await sb.from("job_documents")
      .update({
        file_name: `Client authority - ${facts.job_number} - signed.pdf`,
        storage_url: pdfUrl,
        pdf_url: pdfUrl,
        accepted_at: signedAt,
        metadata,
      })
      .eq("id", doc.id)
      .eq("metadata->>client_authority", "pending")
      .select("id");
    if (upErr) throw new Error(`save failed: ${upErr.message}`);
    if (!updated || updated.length === 0) {
      return json({ ok: true, status: "signed", already_signed: true });
    }
    await sb.from("job_events").insert({
      job_id: doc.job_id,
      event_type: "client_authority_signed",
      detail_json: { document_id: doc.id, signed_name: signedName, signed_at: signedAt, wording_version: wording.version, pdf_sha256: pdfSha },
    });
    return json({ ok: true, status: "signed", signed_at: signedAt, signed_name: signedName });
  } catch (err) {
    console.error("client-authority", err);
    return json({ ok: false, code: "server_error", error: "Something went wrong saving this. Please try again or call us." }, 500);
  }
});
