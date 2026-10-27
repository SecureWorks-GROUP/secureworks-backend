// Who the job dossier and the job story are for (INT-01, Jan 27 Oct 2026):
// "crew members shouldnt or customers, but our internal offie staff that have
// access to ai thats fine". Office staff and their agents read every figure:
// margin, commission, cost, rates and the customer's contact details. Nothing
// that reaches a crew member, supplier or customer reads them.
//
// The dossier is an office read. The front door admits only a staff session
// (admin, owner, ops_manager) or a server secret to assemble_job_dossier, so a
// crew, supplier or customer caller never reaches it. This module is the
// second fence inside the action: a caller that is not office, or a request
// that names an outward audience, is refused rather than handed the office
// shape. Outward surfaces have their own reads and their own fences:
//   crew      trade_job_detail (redactTradeScopeQuote: a scope's `pricing`
//             keeps only the labour budget inputs, money keys are dropped)
//   customer  send-quote's quote page (the customer's own quote)
//   supplier  purchase order emails (the order lines)

export type DossierAudience = "office" | "crew" | "supplier" | "customer";

export const OUTWARD_DOSSIER_AUDIENCES: ReadonlySet<string> = new Set([
  "crew",
  "supplier",
  "customer",
]);

export type DossierAudienceResult =
  | { ok: true; audience: "office" }
  | { ok: false; status: 400 | 403; code: string; error: string };

/**
 * The one decision. callerIsOffice is the front door's answer (a staff JWT or
 * a server secret). asked is body.audience: absent or "office" reads the
 * office shape; crew, supplier or customer is refused with a pointer to that
 * surface's own read; anything else is a caller mistake.
 */
export function resolveDossierAudience(
  callerIsOffice: boolean,
  asked: unknown,
): DossierAudienceResult {
  if (asked !== undefined && asked !== null && asked !== "office") {
    if (typeof asked === "string" && OUTWARD_DOSSIER_AUDIENCES.has(asked)) {
      return {
        ok: false,
        status: 400,
        code: "outward_audience_not_served",
        error:
          `The job dossier is an office read and carries margin, cost and contact details; it is never built for a ${asked}. Use that surface's own read.`,
      };
    }
    return {
      ok: false,
      status: 400,
      code: "invalid_audience",
      error: "audience must be office, crew, supplier or customer",
    };
  }
  if (!callerIsOffice) {
    return {
      ok: false,
      status: 403,
      code: "operator_access_required",
      error: "The job dossier is read by office staff and their agents only.",
    };
  }
  return { ok: true, audience: "office" };
}
