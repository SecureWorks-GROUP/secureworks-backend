// The welcome email a new trade gets straight after their invite.
//
// The invite itself (Supabase auth) only carries a login link. This second
// email says what to do with it: the steps in plain words and a link to the
// welcome page, which holds the 90 second getting-started video
// (secureworks-ux welcome.html). Marnin asked for this on 11 Nov 2026 after a
// new trade typed his pay into the box that takes money off an invoice.
//
// Pure builder plus one sender, so the wording is tested without a network.

export const TRADE_WELCOME_SENDER_MAILBOX = "admin@secureworkswa.com.au";
export const TRADE_WELCOME_PAGE_URL =
  "https://secureworks-group.github.io/secureworks-ux/welcome.html";
export const TRADE_APP_URL =
  "https://secureworks-group.github.io/secureworks-ux/trade.html";

export type TradeWelcomeEmail = {
  subject: string;
  htmlBody: string;
};

export type TradeWelcomeSendResult =
  | { ok: true }
  | { ok: false; error: string };

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** First word of the name the office typed, or nothing if there is none. */
export function tradeFirstName(name: unknown): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  // A name the office never typed can be an email-style handle; greet nobody
  // by "jonathan.482".
  if (!first || /[@\d._]/.test(first)) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function buildTradeWelcomeEmail(
  input: { name?: unknown },
): TradeWelcomeEmail {
  const first = tradeFirstName(input.name);
  const greeting = first ? `Hi ${esc(first)},` : "Hi,";
  const steps = [
    "<strong>Open the invite email</strong> we just sent you and tap the link. It opens the app and signs you in.",
    "<strong>Set a password.</strong> If the app asks for one, choose it now. If it does not, go to Profile, then Password. Locked out later? Tap Forgot password? on the sign-in screen.",
    "<strong>Fill in My Details.</strong> Go to Profile, then My Details. Enter your ABN, BSB and account number, pick your GST status and tap Save Details. No details, no pay.",
    "<strong>Check your pay rate.</strong> Profile shows My Hourly Rate. If it is blank or says Not set yet, tell the office.",
    "<strong>Enter your times.</strong> Jobs you are booked on show up on that week's invoice. Go to Pay, then Weekly Invoice, and on each job enter the date and your start and finish times.",
    "<strong>Send one invoice a week.</strong> At the end of the week tap Submit Invoice. No invoice means no pay for that week.",
  ];
  const htmlBody = `<p>${greeting}</p>` +
    `<p>Welcome to SecureWorks. You use our trade app to see your jobs and to get paid. Here is how to get going.</p>` +
    `<p><a href="${TRADE_WELCOME_PAGE_URL}"><strong>Watch the 90 second video</strong></a> (no sound, the words are on screen).</p>` +
    `<ol>${steps.map((step) => `<li>${step}</li>`).join("")}</ol>` +
    `<p><strong>One thing to watch:</strong> the amount box at the bottom of the invoice takes money <strong>off</strong> your invoice. It is for things like a loan repayment. Do not type your pay into it.</p>` +
    `<p>Open the app any time: <a href="${TRADE_APP_URL}">${TRADE_APP_URL}</a></p>` +
    `<p>Stuck, or a job you worked is missing? Call the office.</p>`;
  return {
    subject: "Welcome to SecureWorks: getting started with the trade app",
    htmlBody,
  };
}

/**
 * Sends the welcome email from the admin@ mailbox through send-outlook-email,
 * the same sender the work order emails to trades use. Never throws: a failed
 * welcome must not undo or hide a successful invite.
 */
export async function sendTradeWelcomeEmail(
  supabaseUrl: string,
  serviceKey: string,
  to: string,
  name: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<TradeWelcomeSendResult> {
  const email = buildTradeWelcomeEmail({ name });
  try {
    const resp = await fetchImpl(
      `${supabaseUrl}/functions/v1/send-outlook-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          mailbox: TRADE_WELCOME_SENDER_MAILBOX,
          to,
          subject: email.subject,
          htmlBody: email.htmlBody,
        }),
      },
    );
    if (resp.ok) return { ok: true };
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      error: `send-outlook-email ${resp.status}: ${text}`.slice(0, 500),
    };
  } catch (err) {
    return {
      ok: false,
      error: `send-outlook-email failed: ${
        err instanceof Error ? err.message : String(err)
      }`.slice(0, 500),
    };
  }
}
