// Existing business inbox classifier, separate from context capture and Luna attribution.
// deno-lint-ignore no-import-prefix
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
export async function classifyEmail(
  from: string,
  subject: string,
  bodyPreview: string,
): Promise<
  {
    classification: string;
    priority: string;
    action_needed: string | null;
    job_ref: string | null;
  }
> {
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        `You classify business emails for a Perth outdoor construction company (SecureWorks WA).
Return JSON only: { "classification": "...", "priority": "...", "action_needed": "..." or null, "job_ref": "SWP-XXXXX" or null }

Classifications: client_reply, supplier_quote, supplier_response, council, invoice, complaint, urgent, newsletter, spam, other
Priority: high (complaints, urgent, council deadlines, large invoices), normal (client replies, supplier responses), low (newsletters, marketing, spam)
action_needed: brief description of recommended action, or null if informational only
job_ref: extract FIRST match from subject or body, in this priority order, or null:
  1. Legacy/bare job number: SW\\d{4,} (e.g., SW1895)
  2. Prefixed: SWP-\\d+, SWF-\\d+, SWD-\\d+ (e.g., SWP-26046)
  3. PO number: PO-\\d+ (e.g., PO-061378) — return as "PO-XXXXXX"
  4. Supplier invoice number: INV-\\d+ — return as "INV-XXXXX"
  5. Supplier quote ref: Quote #\\d+ — return as "Quote#XXX"
Return the raw matched string preserving case/format. Leave null only if none present.`,
      messages: [{
        role: "user",
        content: `From: ${from}\nSubject: ${subject}\nPreview: ${bodyPreview}`,
      }],
    });

    const text = resp.content[0].type === "text" ? resp.content[0].text : "";
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch { /* fall through to default */ }
    }
  } catch (e) {
    console.log("[monitor-inbox] Classification failed:", (e as Error).message);
  }

  return {
    classification: "other",
    priority: "normal",
    action_needed: null,
    job_ref: null,
  };
}
