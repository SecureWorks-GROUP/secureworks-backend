// Who our trading partners are, for the email reader's row builder
// (outlook_mail.ts) and the capture census that re-runs it (finish line row
// C7, 3 Nov 2026).
//
//   * supplier domains: the domains of suppliers.email
//     (context_email_supplier_domains) and of Dispatch's approved supplier
//     order addresses (dispatch_approved_supplier_emails, active: To, CC
//     and the recognise-only also_known_emails, such as Solarspan's address
//     on Bondor's entry since 11 Nov 2026). Most
//     suppliers rows carry no email (Xero sync), so on 3 Nov 2026 the first
//     list held 10 domains and missed Metroll, Bondor, Stratco WA and others
//     Dispatch orders from every day: their auto-replies and bounces were read
//     as automated mail and dropped.
//   * builder senders: makesafe_companies.sender_patterns (active), each a
//     whole address (builderwest.mailer@primeeco.tech) or a domain
//     (ambroseconstruct.com.au). A builder's machine-sent mail (a bookings
//     schedule from its no-reply address) is a customer's mail, not noise.
//   * suppliers we buy from that mail only from a no-reply address and whose
//     Xero contact carries no email (SUPPLIER_SENDER_DOMAINS). suppliers.email
//     cannot hold them: the Xero supplier sync rewrites it every night from
//     the Xero contact (email: EmailAddress or null), and send-po-email sends
//     purchase orders to it, so a no-reply address there would take our
//     orders. When the supplier's Xero contact gets a real email, the sync
//     brings its domain in and the entry here can go.
//
// Our own domains and shared mail services (gmail, bigpond, ...) never mark a
// sender as a partner by domain.

import { isOurAddress } from "./outlook_mail.ts";

/** Shared mail services: a domain here never names one organisation. */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.au",
  "hotmail.com",
  "hotmail.com.au",
  "live.com",
  "live.com.au",
  "msn.com",
  "yahoo.com",
  "yahoo.com.au",
  "icloud.com",
  "me.com",
  "bigpond.com",
  "bigpond.net.au",
  "bigpond.com.au",
  "iinet.net.au",
  "westnet.com.au",
  "optusnet.com.au",
  "tpg.com.au",
  "internode.on.net",
]);

/**
 * Supplier domains with no email on the supplier's record, each with the
 * evidence that we buy from it:
 *   fansonline.com.au: Fans Online, Xero contact
 *     235cf59c-1453-470c-b6b4-f325af2cbb0c, bill FO 192210 of 27 Oct 2026
 *     (patio ceiling fans). Its order received, shipped and invoice mail
 *     comes from donotreply@ (C7 rule proofs, 3 Nov 2026: 3 in one week were
 *     dropped as noise).
 */
export const SUPPLIER_SENDER_DOMAINS: ReadonlySet<string> = new Set([
  "fansonline.com.au",
]);

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS = /^[^\s@<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** An organisation's own domain, or null (ours, shared mail, not a domain). */
function partnerDomain(d: string): string | null {
  if (!DOMAIN.test(d) || SHARED_MAIL_DOMAINS.has(d)) return null;
  return isOurAddress(`x@${d}`) ? null : d;
}

/** The partner domains of some addresses or bare domains. */
export function partnerDomains(values: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const s = clean(v);
    const d = partnerDomain(
      s.includes("@") ? s.slice(s.lastIndexOf("@") + 1) : s,
    );
    if (d) out.add(d);
  }
  return out;
}

/** Builder sender patterns: whole addresses as given, domains only when they name one organisation. */
export function builderSendersFrom(patterns: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const p of patterns) {
    const s = clean(p);
    if (ADDRESS.test(s)) {
      if (!isOurAddress(s)) out.add(s);
    } else {
      const d = partnerDomain(s.replace(/^@/, ""));
      if (d) out.add(d);
    }
  }
  return out;
}

interface Answer {
  data: unknown;
  error: unknown;
}
/** The few service-role reads used here (a supabase-js client). */
export interface PartnerClient {
  rpc(fn: string): PromiseLike<Answer>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): PromiseLike<Answer>;
    };
  };
}

export class PartnerReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The reader's partner sets; throws PartnerReadError (a short code) when a list cannot be read. */
export async function loadTradingPartners(sb: PartnerClient): Promise<{
  supplierDomains: Set<string>;
  builderSenders: Set<string>;
}> {
  const sup = await sb.rpc("context_email_supplier_domains");
  if (sup.error) throw new PartnerReadError("suppliers_unreadable");
  const approved = await sb.from("dispatch_approved_supplier_emails")
    .select("to_emails,cc_emails,also_known_emails").eq("active", true);
  if (approved.error) throw new PartnerReadError("supplier_orders_unreadable");
  const builders = await sb.from("makesafe_companies").select("sender_patterns")
    .eq("active", true);
  if (builders.error) throw new PartnerReadError("builders_unreadable");
  const rows = (d: unknown) =>
    (Array.isArray(d) ? d : []) as Record<string, unknown>[];
  const list = (v: unknown) => (Array.isArray(v) ? v : []) as unknown[];
  return {
    supplierDomains: partnerDomains([
      ...SUPPLIER_SENDER_DOMAINS,
      ...list(sup.data),
      ...rows(approved.data).flatMap((
        r,
      ) => [
        ...list(r.to_emails),
        ...list(r.cc_emails),
        ...list(r.also_known_emails),
      ]),
    ]),
    builderSenders: builderSendersFrom(
      rows(builders.data).flatMap((r) => list(r.sender_patterns)),
    ),
  };
}
