// Quote v2 stage 3: the email and SMS one party gets when their quote is
// sent. PROGRAM BRANCH ONLY.
//
// Built from that party's quote document, so it names only their own share.
// Every message carries the literal {{quote_link}}: the database replaces it
// with the party's fresh link when the owner-stamped send runs, so the stamp
// covers the exact wording and the link is issued once, at send.
//
// Pure. Client-facing copy: plain words, no em dashes.

import { escapeHtml, money } from "./format.ts";
import {
  divisionFor,
  isShared,
  longDate,
  type QuoteDocumentView,
  quoteReference,
} from "./quote_document.ts";

export const QUOTE_LINK_PLACEHOLDER = "{{quote_link}}";

export interface PartyMessages {
  email: { subject: string; text: string; html: string };
  sms: { text: string };
}

export interface MessageOptions {
  /** The person sending, for the sign-off (e.g. "Khairo"). */
  fromName?: string | null;
  /** An optional personal note, shown as its own paragraph. */
  note?: string | null;
}

function trade(v: QuoteDocumentView): string {
  return v.family === "fencing"
    ? "fencing"
    : v.family === "patio"
    ? "patio"
    : v.family === "stratco"
    ? "screening"
    : "";
}

function amountLine(v: QuoteDocumentView): string {
  if (!isShared(v)) return `${money(v.party.share.inc_gst)} including GST`;
  const others = v.other_parties.map((o) => o.first_name).join(" and ");
  return `${
    money(v.party.share.inc_gst)
  } including GST, your ${v.party.share_of_job_percent}% share of the work shared with ${others}`;
}

export function buildPartyMessages(
  v: QuoteDocumentView,
  opts: MessageOptions = {},
): PartyMessages {
  const div = divisionFor(v.family);
  const kind = trade(v);
  const what = kind ? `${kind} quote` : "quote";
  const where = v.site_suburb ? ` in ${v.site_suburb}` : "";
  const ref = quoteReference(v);
  const name = v.party.first_name;
  const from = opts.fromName?.trim() || "The SecureWorks Group team";
  const note = opts.note?.trim() || "";
  const link = QUOTE_LINK_PLACEHOLDER;
  const pdf = `${QUOTE_LINK_PLACEHOLDER}&format=pdf`;
  const subject = `Your SecureWorks Group ${what}${where} (${ref})`;
  const valid = longDate(v.valid_until);

  const text = [
    `Hi ${name},`,
    "",
    ...(note ? [note, ""] : []),
    `Thank you for the chance to quote on your ${
      what.replace(/ quote$/, "")
    } project${where}. Your quote is ready: ${amountLine(v)}.`,
    "",
    `View and accept your quote: ${link}`,
    `Download it as a PDF: ${pdf}`,
    "",
    `The price holds until ${valid}. If you have any questions, call or text ${div.phone} or reply to this email.`,
    "",
    from,
    "SecureWorks Group",
  ].join("\n");

  const p = (s: string) =>
    `<p style="color:#4C6A7C;font-size:15px;line-height:1.6;margin:0 0 16px;">${s}</p>`;
  const button = (href: string, label: string, bg: string) =>
    `<table cellpadding="0" cellspacing="0" style="margin:0 auto 10px;"><tr><td style="background:${bg};border-radius:8px;"><a href="${href}" style="display:inline-block;padding:14px 32px;color:#fff;text-decoration:none;font-size:16px;font-weight:600;">${label}</a></td></tr></table>`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;">
<tr><td style="background:#F15A29;height:4px;"></td></tr>
<tr><td style="background:#293C46;padding:20px 32px;"><span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:0.5px;">SecureWorks</span><span style="color:rgba(255,255,255,0.6);font-size:16px;margin-left:4px;">Group</span></td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px;color:#293C46;font-size:22px;">Your ${
    escapeHtml(what)
  } is ready</h1>
${p(`Hi ${escapeHtml(name)},`)}
${
    note
      ? `<p style="color:#333;font-size:15px;line-height:1.6;margin:0 0 16px;">${
        escapeHtml(note)
      }</p>`
      : ""
  }
${
    p(`Thank you for the chance to quote on your ${
      escapeHtml(what.replace(/ quote$/, ""))
    } project${
      escapeHtml(where)
    }. Your quote comes to <strong style="color:#293C46;">${
      escapeHtml(amountLine(v))
    }</strong>.`)
  }
${button(link, "View and accept your quote", "#F15A29")}
${button(pdf, "Download your PDF quote", "#293C46")}
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
${
    p(`The price holds until ${
      escapeHtml(valid)
    }. If you have any questions, call or text <a href="tel:+61${
      div.phone.replace(/\s+/g, "").slice(1)
    }" style="color:#F15A29;text-decoration:none;">${
      escapeHtml(div.phone)
    }</a> or reply to this email.`)
  }
<p style="color:#293C46;font-size:14px;font-weight:600;margin:0;">${
    escapeHtml(from)
  }<br><span style="font-weight:400;color:#4C6A7C;">SecureWorks Group</span></p>
</td></tr>
<tr><td style="background:#293C46;padding:20px 32px;"><p style="color:#fff;font-size:13px;margin:0;text-align:center;line-height:1.6;"><strong>SecureWorks Group</strong> - Insulated Patios | Fencing &amp; Screening | Composite Decking</p></td></tr>
<tr><td style="background:#f5f5f7;padding:20px 32px;border-top:1px solid #eee;"><p style="color:#999;font-size:11px;margin:0;line-height:1.5;">SecureWorks Group Pty Ltd | ABN 64 689 223 416<br>Quote ${
    escapeHtml(ref)
  }, valid until ${escapeHtml(valid)}.</p></td></tr>
</table></body></html>`;

  const sms = `Hi ${name}, your SecureWorks Group ${what}${where} is ready: ${
    money(v.party.share.inc_gst)
  } inc GST. View and accept it here: ${link}`;
  return { email: { subject, text, html }, sms: { text: sms } };
}
