import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";
import type { SesPricingDisposition } from "./makesafe_invoice_obligation.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";
import { SES_ASSESSMENT_RECIPE_VERSION } from "./ses_family_matrix.ts";
import {
  requiredSesRouteKinds,
  type SesRouteKind,
} from "./ses_release_route_shape.ts";
export {
  requiredSesRouteKinds,
  type SesRouteKind,
} from "./ses_release_route_shape.ts";
import {
  describeExistingCardMoney,
  type SesExistingCardMoney,
} from "./ses_existing_card_money.ts";

export const SES_REVIEW_SECTION_ORDER = [
  "job_story",
  "status",
  "insurance_work_order",
  "family_evidence",
  "swms",
  "money",
  "email_drafts",
  "crew_and_trade_visits",
  "decision_controls",
] as const;

/** Universal three-route order (MLB and non-AJS builders). */
export const SES_ROUTE_ORDER: SesRouteKind[] = ["report", "photo", "invoice"];

export interface SesReviewRoute {
  route_kind: SesRouteKind;
  recipients: string[];
  cc?: string[];
  subject: string;
  body: string;
  attachment_hashes: string[];
  ready: boolean;
  /**
   * MLB physical report/photo: Graph Groups conversationThreadId for the
   * mailer / work-order intake thread. Required when requires_thread_reply.
   */
  reply_to_thread_id?: string | null;
  /**
   * Optional group post id (audit / anchor). Group-thread reply uses
   * reply_to_thread_id; this is not a silent admin@ createReply fallback.
   */
  reply_to_graph_message_id?: string | null;
  /** When true, send must reply on the intake thread or refuse. */
  requires_thread_reply?: boolean;
}

const SES_EMAIL_ADDRESS_RE = /^[^\s@<>,;:]+@[^\s@<>,;:]+$/;

export function invalidSesRouteRecipients(
  route: Pick<SesReviewRoute, "recipients" | "cc">,
): string[] {
  return [...(route.recipients || []), ...(route.cc || [])].filter((value) =>
    !SES_EMAIL_ADDRESS_RE.test(String(value || "").trim())
  );
}

export function assertSesRouteRecipients(
  route: Pick<SesReviewRoute, "recipients" | "cc">,
): void {
  const invalid = invalidSesRouteRecipients(route);
  if (invalid.length > 0) {
    throw new TypeError("release route contains a non-email recipient");
  }
}

export interface SesCleanInput {
  pre_xero_docs_ready: boolean;
  readiness_ready: boolean;
  readiness_blockers: SesRefusal[];
  pricing_disposition: SesPricingDisposition;
  line_overrides_audited: boolean;
  duplicate_allows_create: boolean;
  invoice_already_bound: boolean;
  duplicate_ambiguity: string;
  money_blocker_codes: string[];
  post_release_disposition_outstanding: boolean;
  family: string;
  family_matrix_version: string | null;
  assessment_recipe_version: string | null;
  portal_required: boolean;
  portal_capture_status: "done" | "not_done" | "unreachable" | "not_applicable";
  own_document_exemption: boolean;
  physical_media_complete: boolean;
  completed_work_photo_proven: boolean;
  obligation_revision_count: number;
  routes: SesReviewRoute[];
  /**
   * Whether this card's family matrix routes a photo email at all
   * (`photo_route: "work_order_sender"`). Report-only families declare
   * `photo_route: "not_applicable"`, and the assembler correctly emits no
   * PHOTO_EMAIL_DRAFT for them — so demanding one is an unsatisfiable HOLD.
   * Requirement scope belongs to `ses_family_matrix.ts`, not to this consumer.
   *
   * Optional: an absent value means "required", so a producer that has not been
   * taught this field can only ever be stricter, never accidentally looser.
   */
  photo_route_applicable?: boolean;
  /**
   * Whether this card's family sends a builder report email at all. A card whose
   * report is the builder portal declares `draft_builder_report_email:
   * not_applicable` ("portal-is-the-report") and the assembler correctly emits
   * no REPORT_EMAIL_DRAFT for it — so demanding one is an unsatisfiable HOLD,
   * exactly as it was for the photo email above.
   *
   * Captain ruling 2026-08-06 (`report-only-email-applicability`): a roof-report
   * card sends ONE email, to the group inbox, carrying the invoice. Note this is
   * NOT the same set as `report_only`: `own_template_roof` is report-only and
   * still sends a real report email on our own letterhead, so it must keep the
   * route. Requirement scope belongs to the family matrix and the manifest it
   * drives, not to this consumer.
   *
   * Optional: an absent value means "required", so a producer that has not been
   * taught this field can only ever be stricter, never accidentally looser.
   */
  report_route_applicable?: boolean;
  type_check_hold: boolean;
  story_unverified: boolean;
  trade_report_submitted: boolean;
  roof_report_required: boolean;
  roof_report_filled: boolean;
  report_only: boolean;
  /** Builder key from the family matrix / docket classification (AJS, AJBR, MLB, …). */
  builder_key?: string | null;
  /** Exact matrix route coordinate stamped into the prepared docket. */
  routing_rule?: string | null;
  /** Backend workflow variant and hash bound into the docket output bytes. */
  workflow_contract_variant_id?: string | null;
  workflow_contract_hash?: string | null;
  deliverable_active?: boolean;
}

export interface SesCleanCheck {
  id: `C${number}`;
  passed: boolean;
  fact: string;
}

export interface SesMechanicalCleanResult {
  clean: boolean;
  checks: SesCleanCheck[];
  blockers: SesRefusal[];
  approval_band: "shaun_clean" | "captain_only" | "decision_blocked";
}

function check(
  id: SesCleanCheck["id"],
  passed: boolean,
  fact: string,
): SesCleanCheck {
  return { id, passed, fact };
}

/**
 * Known sealed route kinds in a stable display/send order. Universal three-route
 * cards use report/photo/invoice; AJS/AJBR use report_invoice then photo. The
 * universal `SES_ROUTE_ORDER` stays three-wide so requirement checks do not
 * demand the AJS combined route on every builder.
 */
const SES_ROUTE_DISPLAY_ORDER: string[] = [
  "report",
  "report_invoice",
  "photo",
  "invoice",
];

/**
 * The route kinds actually drafted on this pack, in send order. Unknown kinds
 * (a newly sealed route shape) are appended rather than dropped, so a route the
 * Captain would really send can never be invisible in the copy below.
 */
export function sesRouteKindsOnPack(routes: SesReviewRoute[]): string[] {
  const present = routes.map((route) => String(route.route_kind));
  const ordered = SES_ROUTE_DISPLAY_ORDER.filter((kind) =>
    present.includes(kind)
  );
  const extra = present.filter((kind) =>
    !SES_ROUTE_DISPLAY_ORDER.includes(kind)
  );
  return [...ordered, ...new Set(extra)];
}

function joinRouteKinds(kinds: string[]): string {
  const labels = kinds.map((kind) => kind.replaceAll("_", " "));
  if (labels.length <= 1) return labels[0] || "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * SEND IT copy generated from the real route list. The cockpit used to narrate
 * "report, photo, and invoice" on every card regardless of what was drafted,
 * which told the Captain he was sending three emails when the pack held two.
 */
export function describeSesSendItPlan(routes: SesReviewRoute[]): string {
  const kinds = sesRouteKindsOnPack(routes);
  if (kinds.length === 0) {
    return "No email route is drafted on this release revision yet, so there is nothing to send.";
  }
  const noun = kinds.length === 1 ? "route" : "routes";
  return `Send the approved ${
    joinRouteKinds(kinds)
  } ${noun} (${kinds.length}) for this exact release revision, then write route proofs and closeout.`;
}

/**
 * A refusal when Xero already holds live money for this card that the current
 * docket does not bind.
 *
 * This is deliberately ONE-WAY: it returns a refusal or it returns null. There
 * is no branch here that clears an existing blocker, so wiring it can only ever
 * make a card LESS approvable. That property is the reason it was safe to land
 * hours before the Captain approves from this board, and it must be preserved.
 *
 * It fires only when nothing is bound. A card whose docket already binds its
 * invoice is the healthy case and is never touched.
 *
 * The money it reads is CURRENT-CYCLE money. A prior-cycle terminal state must
 * never silence a current-cycle question, and the converse holds too: an
 * invoice raised for an earlier attendance is not this cycle's money and never
 * refuses this cycle. That boundary lives in `classifyExistingCardMoney`, which
 * consumes the card's one cycle engine.
 *
 * An UNEVALUATED reading (nobody asked) is not "no money": with nothing bound
 * it refuses, exactly like an unreadable mirror.
 */
export function existingCardMoneyRefusal(
  boundStatus: string | null | undefined,
  money: SesExistingCardMoney | null | undefined,
): SesRefusal | null {
  if (String(boundStatus || "").trim()) return null;
  if (!money) return null;
  if (money.evaluated && !money.exists) return null;
  return sesRefusal(
    "invoice_exists_unbound",
    "Check Xero by REFERENCE before any mint. Bind or link the existing invoice, " +
      "or record an explicit disposition. Do not mint a second invoice on this card.",
    {
      fact: describeExistingCardMoney(money),
      evidence: {
        mirror_unreadable: money.unreadable,
        mirror_evaluated: money.evaluated,
        invoices: money.rows,
      },
    },
  );
}

/**
 * The ONE producer of the verdict every approval surface must evaluate. The
 * cockpit view and both approve actions consume it, so they can never disagree
 * about whether the money blocker exists.
 *
 * Strictly additive: the blocker list only ever GROWS and `clean` is only ever
 * forced false. The money blocker is placed FIRST so a caller that reports
 * `blockers[0]` names the money rather than a generic hold.
 *
 * NOTE for the approve actions: a non-clean verdict is CAPTAIN-OVERRIDABLE
 * (`canRecordSesApproval`), so enriching the verdict is not on its own a stop.
 * Pair it with `existingCardMoneyRefusal` as a hard refusal — see
 * `refuseWhenCardMoneyExists` in ses_reporting_actions.ts.
 *
 * Pricing disposition is deliberately NOT an input. The only path where the
 * question is inapplicable is a release member that mints nothing, and that
 * exemption belongs to that one call site: applying it here would take the
 * refusal off the cockpit and off APPROVE INVOICE, which is a card becoming
 * more approvable.
 */
export function sesVerdictWithExistingMoney(
  mechanical: SesMechanicalCleanResult,
  boundStatus: string | null | undefined,
  money: SesExistingCardMoney | null | undefined,
): SesMechanicalCleanResult {
  const blocker = existingCardMoneyRefusal(boundStatus, money);
  if (!blocker) return mechanical;
  return {
    ...mechanical,
    blockers: [blocker, ...mechanical.blockers],
    clean: false,
  };
}

/**
 * Why APPROVE INVOICE is unavailable, in the operator's terms. The commonest
 * case by far is the healthy one: the invoice is already authorised, so there is
 * nothing left to approve and a second approve would commit the money twice.
 */
export function approveInvoiceDisabledReason(
  docket: { xero_binding?: Record<string, unknown> | null },
  state: {
    stale: boolean;
    xeroAuthorised: boolean;
    noAdditionalCharge: boolean;
    /**
     * Live money already in Xero for this card that the docket does NOT bind.
     * Present only to REPLACE the mint invitation below with the truth; it can
     * never enable this control.
     */
    existingMoney?: SesExistingCardMoney | null;
  },
): string {
  const binding = docket.xero_binding || {};
  const number = String(binding.invoice_number || "").trim();
  if (state.xeroAuthorised) {
    return `Invoice already authorised${
      number ? ` (${number})` : ""
    }. The money is committed, so there is nothing left to approve — the next step is SEND IT when you say so.`;
  }
  if (state.noAdditionalCharge) {
    return "This card is priced as no additional charge, so no invoice is approved for it.";
  }
  if (state.stale) {
    return "This view is showing an older docket revision. Reload the card, then approve against the current pack.";
  }
  if (!binding || !String(binding.status || "").trim()) {
    // "Nothing is BOUND" is not "nothing EXISTS". A hand-made Xero invoice that
    // was never linked to the job, or one linked but never bound to this
    // docket, is invisible to `xero_binding` — and inviting a mint on top of it
    // is an invitation to bill already-billed work. Measured 2026-08-06: all 16
    // unbound Docs Ready cards already had live money under their own
    // reference, seven of them already PAID.
    if (
      state.existingMoney &&
      (state.existingMoney.exists || !state.existingMoney.evaluated)
    ) {
      return `${
        describeExistingCardMoney(state.existingMoney)
      } Do NOT mint a second invoice. ` +
        `Bind or link the existing invoice, or record an explicit disposition — ` +
        `this card is a finding for the Captain, not a mint.`;
    }
    return "No Xero DRAFT invoice is bound to this card yet. Mint the draft first, then approve it.";
  }
  const status = String(binding.status || "").toUpperCase();
  if (status !== "DRAFT") {
    return `The bound Xero invoice is ${status}, not DRAFT, so it is not awaiting approval.`;
  }
  return "One or more checks on this card have not passed yet — see the blockers listed above.";
}

/**
 * The checks that did not pass, carrying their own facts verbatim.
 *
 * A check's `fact` is phrased AFFIRMATIVELY — it states the condition that
 * holds when the check passes — so it is never a sentence about what is wrong
 * and must never be re-worded into one on the way out. This is a pass-through:
 * the backend owns the fact, the consumer owns the sentence it builds from it.
 * An empty array means nothing here can be named, and the consumer falls back
 * to the honest generic rather than to a guess.
 */
export function sesFailedChecks(
  verdict: SesMechanicalCleanResult,
): Array<{ id: string; fact: string }> {
  return (verdict.checks || [])
    .filter((item) => !item.passed)
    .map((item) => ({ id: String(item.id), fact: item.fact }));
}

/**
 * Why SEND IT is unavailable, in the operator's terms.
 *
 * SEND is the control the Captain is most likely to be waiting on, so a
 * generic "locked by the hold above" is the least useful thing this payload
 * can say. Name the real cause, and when the cause is a blocker, quote that
 * blocker's own fact rather than paraphrasing it — the fact is the trustworthy
 * string, and it now names the exact email and defect.
 *
 * With no blocker to quote, this asserts NOTHING specific. The failed checks
 * ride alongside as structured data instead; inventing a negative sentence
 * about pricing, money or obligation ownership here would put an unproven
 * money claim on the screen the Captain uses to decide whether to send.
 */
export function sendItDisabledReason(
  verdict: SesMechanicalCleanResult,
  state: {
    stale: boolean;
    xeroAuthorised: boolean;
    noAdditionalCharge: boolean;
    xeroStatus?: string | null;
  },
): string {
  if (state.stale) {
    return "This view is showing an older docket revision. Reload the card before sending anything.";
  }
  if (!verdict.clean) {
    const blockers = verdict.blockers || [];
    const first = blockers[0];
    if (first?.fact) {
      const others = blockers.length - 1;
      return others > 0
        ? `${first.fact} ${others} other blocker${
          others === 1 ? "" : "s"
        } must clear too.`
        : first.fact;
    }
    return "This pack is not ready to send yet.";
  }
  if (!state.xeroAuthorised && !state.noAdditionalCharge) {
    const status = String(state.xeroStatus || "").toUpperCase();
    return status
      ? `The bound Xero invoice is ${status}, not AUTHORISED. The invoice email cannot go out against an unauthorised invoice.`
      : "No authorised Xero invoice is bound to this card yet, and the invoice email cannot go out without one.";
  }
  return "The system has not unlocked sending for this pack yet.";
}

/** Human label for a route kind — "photo email", never "builder email draft". */
function routeEmailLabel(kind: SesRouteKind): string {
  return `${String(kind).replaceAll("_", " ")} email`;
}

type SesRouteDraftDefect =
  | "absent"
  | "no_attachments"
  | "no_subject"
  | "no_body"
  | "not_ready";

/**
 * The ONE classification of what is wrong with a required route's draft. The
 * fact and the remedy below are two sentences about the same defect and must
 * never disagree, and the fact is now quoted verbatim into
 * `send_it.disabled_reason` — so a second copy of this ladder would surface its
 * drift twice. Classify once here; both sentences switch on the result.
 */
function classifySesRouteDraftDefect(
  route: SesReviewRoute | undefined,
): SesRouteDraftDefect {
  if (!route) return "absent";
  if ((route.attachment_hashes?.length ?? 0) === 0) return "no_attachments";
  if (!route.subject.trim()) return "no_subject";
  if (!route.body.trim()) return "no_body";
  return "not_ready";
}

/**
 * The FACT for a `route_draft_missing` blocker. The catalogue default says only
 * "A required builder email draft is missing", which reads as random on a card
 * where the operator can see report and invoice are fine. Name the email and
 * what is actually wrong with it, so the fact stands on its own even in a
 * consumer that renders nothing else.
 *
 * This states only what IS — it is still a fact, not a remedy; the recovery
 * action below remains the separate "what clears it" sentence.
 */
function routeDraftFact(
  kind: SesRouteKind,
  route: SesReviewRoute | undefined,
): string {
  const label = routeEmailLabel(kind);
  switch (classifySesRouteDraftDefect(route)) {
    case "absent":
      return `The ${label} has no draft on the current docket revision.`;
    case "no_attachments":
      return `The ${label} is drafted but carries no attachments on the current docket revision.`;
    case "no_subject":
      return `The ${label} has no subject on the current docket revision.`;
    case "no_body":
      return `The ${label} has no body on the current docket revision.`;
    case "not_ready":
      return `The ${label} is not marked ready on the current docket revision.`;
  }
}

/**
 * The remedy sentence beside a `route_draft_missing` blocker. The FACT is
 * `routeDraftFact` above (it overrides the catalogue default) and is
 * trustworthy; this text is the "clear path" the Captain reads next, so it must
 * name the exact email and the exact reason rather than inventing a generic
 * instruction.
 */
function routeDraftRemedy(
  kind: SesRouteKind,
  route: SesReviewRoute | undefined,
): string {
  const label = routeEmailLabel(kind);
  switch (classifySesRouteDraftDefect(route)) {
    case "absent":
      return `This docket revision carries no ${label} draft at all. Prepare a new docket revision (prepare_ses_docket_revision) so the ${label} is assembled, then re-check this card.`;
    case "no_attachments":
      return `The ${label} is drafted but has no attachments bound to this docket revision, so there is nothing to send on it. Prepare a new docket revision so the current attendance cycle's files are attached; if the pack was already invoice_bound, re-run the AUTHORISED invoice PDF bind afterwards so the new revision keeps the invoice.`;
    case "no_subject":
      return `The ${label} is missing its subject on this docket revision. Prepare a new docket revision so the draft is rebuilt.`;
    case "no_body":
      return `The ${label} is missing its body on this docket revision. Prepare a new docket revision so the draft is rebuilt.`;
    case "not_ready":
      return `The ${label} is not marked ready on this docket revision. Prepare a new docket revision and re-check this card.`;
  }
}

function missingRouteRefusals(
  routes: SesReviewRoute[],
  family: string,
  photoRouteApplicable: boolean,
  builderKey?: string | null,
  reportRouteApplicable = true,
): SesRefusal[] {
  const byKind = new Map(routes.map((route) => [route.route_kind, route]));
  const refusals: SesRefusal[] = [];
  // Assessment stays invoice-only. AJS/AJBR use the two-email shape
  // (report+invoice combined, photo). Everyone else keeps three routes.
  // photoRouteApplicable keeps report-only families from demanding a photo, and
  // reportRouteApplicable does the same for the report email on a card whose
  // report lives in the builder portal (Captain 2026-08-06).
  const requiredRoutes = requiredSesRouteKinds(
    family,
    photoRouteApplicable,
    builderKey,
    reportRouteApplicable,
  );
  for (const kind of requiredRoutes) {
    const route = byKind.get(kind);
    if (!route || !route.ready || !route.subject.trim() || !route.body.trim()) {
      refusals.push(
        sesRefusal(
          "route_draft_missing",
          routeDraftRemedy(kind, route),
          {
            fact: routeDraftFact(kind, route),
            evidence: {
              route_kind: kind,
              route_present: !!route,
              route_ready: route?.ready === true,
              attachment_count: route?.attachment_hashes?.length ?? 0,
            },
          },
        ),
      );
      continue;
    }
    if (route.recipients.length === 0) {
      refusals.push(
        sesRefusal(
          "canonical_recipient_missing",
          `Recover the canonical builder mailbox for the ${kind} route.`,
          { evidence: { route_kind: kind } },
        ),
      );
    }
  }
  return refusals;
}

export function evaluateSesMechanicalClean(
  input: SesCleanInput,
): SesMechanicalCleanResult {
  const pricingClean = input.pricing_disposition === "priced_from_canon" ||
    input.pricing_disposition === "no_additional_charge" ||
    (input.pricing_disposition === "priced_with_line_override" &&
      input.line_overrides_audited);
  const moneyBlocked = input.money_blocker_codes.some((code) =>
    [
      "money_review_required",
      "billing_disposition_required",
      "company_ambiguous",
      "blocked_parked_rule",
    ].includes(code)
  );
  const portalClean = !input.portal_required ||
    input.own_document_exemption ||
    input.portal_capture_status === "done";
  const physical = input.family === "physical_makesafe" ||
    input.family === "temporary_fencing";
  const routeRefusals = missingRouteRefusals(
    input.routes,
    input.family,
    input.photo_route_applicable !== false,
    input.builder_key,
    input.report_route_applicable !== false,
  );
  const checks: SesCleanCheck[] = [
    check(
      "C1",
      input.pre_xero_docs_ready || input.invoice_already_bound,
      "The current family docket is commercially ready.",
    ),
    // C2 names missing facts, not the historical readiness.ready flag.
    // That flag stays false with empty blockers after the 2026-08-03 drop of
    // the unsatisfiable readiness precondition (approval/obligation/release
    // no longer assert it). Requiring the flag here recreated a false hold:
    // Docs Ready / APPROVE stayed dark even when every named readiness
    // blocker was gone and a live Xero DRAFT was already bound.
    check(
      "C2",
      input.readiness_blockers.length === 0,
      "No named readiness blockers remain on the current revision.",
    ),
    check(
      "C3",
      pricingClean,
      "Pricing is settled by canon or audited override.",
    ),
    check(
      "C4",
      input.pricing_disposition === "no_additional_charge" ||
        input.invoice_already_bound || input.duplicate_allows_create,
      "The duplicate probe is consistent with the requested money action.",
    ),
    check("C5", !moneyBlocked, "No unresolved money hold remains."),
    check(
      "C6",
      !input.post_release_disposition_outstanding,
      "No post-release billing disposition is outstanding.",
    ),
    check(
      "C7",
      !!input.family_matrix_version &&
        (input.family !== "assessment_quote" ||
          input.assessment_recipe_version ===
            SES_ASSESSMENT_RECIPE_VERSION),
      "The family matrix and required assessment recipe are versioned.",
    ),
    check("C8", portalClean, "Required portal truth is captured."),
    check(
      "C9",
      !physical ||
        (input.physical_media_complete && input.completed_work_photo_proven),
      "Physical work has the full media floor and completed-work proof.",
    ),
    check(
      "C10",
      input.obligation_revision_count === 1 &&
        input.duplicate_ambiguity !== "multi_live",
      "Exactly one non-ambiguous obligation revision owns this work.",
    ),
    check(
      "C11",
      routeRefusals.length === 0,
      "Every route required by this family has canonical recipients and a draft.",
    ),
    check(
      "C12",
      !input.type_check_hold && !input.story_unverified,
      "No type-check or unverified-story hold remains.",
    ),
  ];

  const blockers: SesRefusal[] = [
    ...input.readiness_blockers,
    ...routeRefusals,
  ];
  if (!input.trade_report_submitted) {
    blockers.push(
      sesRefusal(
        "no_trade_report_submitted",
        "Ask the assigned trade to submit the current Visit report before review.",
      ),
    );
  }
  if (
    input.portal_required &&
    input.portal_capture_status === "unreachable" &&
    !input.own_document_exemption
  ) {
    blockers.push(
      sesRefusal(
        "portal_link_dead",
        "Recover a working portal link and capture the completed builder report.",
      ),
    );
  }
  if (input.roof_report_required && !input.roof_report_filled) {
    blockers.push(
      sesRefusal(
        "roof_report_not_filled",
        "Complete and render the SecureWorks roof report before review.",
      ),
    );
  }
  if (
    input.family === "assessment_quote" &&
    input.assessment_recipe_version !== SES_ASSESSMENT_RECIPE_VERSION
  ) {
    blockers.push(
      sesRefusal(
        "assessment_recipe_parked",
        "Wait for the Captain to settle the assessment outbound recipe, then prepare a new docket revision.",
        { decision_key: "assessment-outbound-recipe" },
      ),
    );
  }
  // RULED, not removed. `report-only-email-applicability` parked every
  // report-only card here pending the Captain's decision on whether report-only
  // work uses the universal three-email release. He ruled it on 2026-08-06
  // (`data/decisions/2026-08-06-roof-report-email-shape.md`): a roof-report card
  // sends ONE email, to the group inbox, carrying the invoice — the exemption
  // path, not a fabricated empty report email. A decided question must stop
  // holding cards, so nothing is pushed here any more; the ruling now lives in
  // `report_route_applicable` above, where it changes what is REQUIRED rather
  // than adding a second thing to wait for. Do not reintroduce this blocker to
  // re-park the question — reopening it is a new Captain decision with its own
  // key, not a revival of this one.
  if (
    input.post_release_disposition_outstanding &&
    !blockers.some((blocker) =>
      blocker.code === "post_release_disposition_missing"
    )
  ) {
    blockers.push(
      sesRefusal(
        "post_release_disposition_missing",
        "Record the human billing disposition for the later attendance.",
        { decision_key: "post-release-reattend-disposition" },
      ),
    );
  }

  const decisionBlocked = blockers.some((blocker) => !!blocker.decision_key);
  const clean = checks.every((item) => item.passed) && blockers.length === 0;
  return {
    clean,
    checks,
    blockers,
    approval_band: decisionBlocked
      ? "decision_blocked"
      : (clean ? "shaun_clean" : "captain_only"),
  };
}

/**
 * Progress of the sealed SES release against the builder for this card.
 * Pure classification over release state + route proofs — never invents a send.
 *
 *   none               — no proved routes; SEND IT may still be the honest action
 *   partially_released — some required routes proved, others not (Captain decision)
 *   closeout_pending   — every required route proved, closeout not yet verified
 *   released           — release state released and/or closeout verified
 */
export type SesReleaseSendProgress =
  | { kind: "none" }
  | {
    kind: "released";
    release_revision_id: string;
    release_state: string;
    proved_route_kinds: string[];
    required_route_kinds: string[];
  }
  | {
    kind: "closeout_pending";
    release_revision_id: string;
    release_state: string;
    proved_route_kinds: string[];
    required_route_kinds: string[];
  }
  | {
    kind: "partially_released";
    release_revision_id: string;
    release_state: string;
    proved_route_kinds: string[];
    required_route_kinds: string[];
    missing_route_kinds: string[];
  };

/**
 * Classify release/send progress from ledger facts only. Does not mark a route
 * sent without a proof row; does not invent closeout.
 */
export function classifySesReleaseSendProgress(args: {
  release_revision_id?: string | null;
  release_state?: string | null;
  required_route_kinds?: string[] | null;
  proved_route_kinds?: string[] | null;
  closeout_verified?: boolean | null;
}): SesReleaseSendProgress {
  const releaseId = String(args.release_revision_id || "").trim();
  if (!releaseId) return { kind: "none" };
  const releaseState = String(args.release_state || "").trim().toLowerCase();
  const required = [
    ...new Set(
      (args.required_route_kinds || []).map((k) => String(k || "").trim())
        .filter(Boolean),
    ),
  ].sort();
  const proved = [
    ...new Set(
      (args.proved_route_kinds || []).map((k) => String(k || "").trim())
        .filter(Boolean),
    ),
  ].sort();
  const missing = required.filter((kind) => !proved.includes(kind));
  const allProved = required.length > 0 && missing.length === 0;
  const closeoutVerified = args.closeout_verified === true ||
    releaseState === "released";

  if (closeoutVerified && (allProved || proved.length > 0)) {
    return {
      kind: "released",
      release_revision_id: releaseId,
      release_state: releaseState || "released",
      proved_route_kinds: proved,
      required_route_kinds: required,
    };
  }
  if (allProved) {
    return {
      kind: "closeout_pending",
      release_revision_id: releaseId,
      release_state: releaseState || "dispatching",
      proved_route_kinds: proved,
      required_route_kinds: required,
    };
  }
  if (proved.length > 0) {
    return {
      kind: "partially_released",
      release_revision_id: releaseId,
      release_state: releaseState || "dispatching",
      proved_route_kinds: proved,
      required_route_kinds: required,
      missing_route_kinds: missing,
    };
  }
  return { kind: "none" };
}

export function releaseSendProgressBlocksSend(
  progress: SesReleaseSendProgress,
): boolean {
  return progress.kind !== "none";
}

export function describeReleaseSendProgress(
  progress: SesReleaseSendProgress,
): string | null {
  if (progress.kind === "none") return null;
  if (progress.kind === "released") {
    return `This release is already complete (release ${
      progress.release_revision_id.slice(0, 8)
    }…). Do not send again.`;
  }
  if (progress.kind === "closeout_pending") {
    const kinds = progress.proved_route_kinds.join(", ") ||
      "all required routes";
    return `Every required route is already proved on the ledger (${kinds}); closeout verification is still incomplete. Do not send again — finish closeout, never re-dispatch.`;
  }
  const missing = progress.missing_route_kinds.join(", ") || "unknown";
  const proved = progress.proved_route_kinds.join(", ") || "none";
  return `This release is only part-proved (proved: ${proved}; missing: ${missing}). Do not send again — escalate the missing route to the Captain.`;
}

export interface SesCockpitDocket {
  job_id: string;
  job_number: string | null;
  docket_revision_id: string;
  /** The revision's sealed output hash, so a viewer can fetch the byte-exact pack. */
  docket_output_content_hash?: string | null;
  readiness_revision: string;
  dependency_generation: number;
  invoice_obligation_revision_id: string | null;
  attendance_cycle_ids: string[];
  xero_binding: {
    xero_invoice_id: string;
    invoice_number: string;
    status: string;
    total?: number | null;
    pdf_content_hash?: string;
    pdf_object_key?: string;
    pdf_size_bytes?: number;
  } | null;
  /**
   * Proof that the REAL Xero PDF can be shown right now: an AUTHORISED docket
   * artifact, or a successful live DRAFT re-fetch. Absent means "not proved",
   * which reads as unavailable — never claim a document from a stored hash.
   */
  xero_invoice_pdf_available?: boolean;
  /**
   * Live Xero money for this card that the docket does NOT bind. Read by
   * reference, because "nothing is bound" is not "nothing exists".
   */
  existing_card_money?: SesExistingCardMoney | null;
  local_invoice_proposal: Record<string, unknown> | null;
  work_order: Record<string, unknown> | null;
  family_evidence: Record<string, unknown>;
  swms: Record<string, unknown>;
  routes: SesReviewRoute[];
  caveats?: SesReviewCaveat[];
  crew_and_trade_visits: unknown;
  clean_input: SesCleanInput;
  /**
   * Sealed release/send progress for this job. Absent or `none` means the
   * card has no proved routes yet; any other kind must leave SEND_READY.
   */
  release_send_progress?: SesReleaseSendProgress;
}

export interface SesReviewCaveat {
  state: "caveat";
  code: string;
  fact: string;
  recovery_action: string;
  evidence?: Record<string, unknown>;
}

export interface SesCockpitView {
  schema: "secureworks.makesafe.ses-review-cockpit/v1";
  section_order: typeof SES_REVIEW_SECTION_ORDER;
  status:
    | "PRE_XERO_DOCS_READY"
    | "INVOICE_CREATE_READY"
    | "SEND_READY"
    | "RELEASED"
    | "CLOSEOUT_PENDING"
    | "PARTIALLY_RELEASED"
    | "HOLD";
  stale: boolean;
  verdict: SesMechanicalCleanResult;
  caveats: SesReviewCaveat[];
  sections: Record<string, unknown>;
  controls: {
    approve_invoice: {
      enabled: boolean;
      label: "APPROVE INVOICE";
      plan: string;
      /** Why the control is unavailable; null when it is enabled. */
      disabled_reason: string | null;
    };
    send_it: {
      enabled: boolean;
      label: "SEND IT";
      plan: string;
      /** Why the control is unavailable; null when it is enabled. */
      disabled_reason: string | null;
      /**
       * The mechanical checks that did not pass, each with its own affirmative
       * fact verbatim. Structured so the consumer names the cause itself
       * instead of the backend inventing copy; empty when every check passed,
       * in which case the consumer shows the honest generic.
       */
      failed_checks: Array<{ id: string; fact: string }>;
      /** The route kinds actually drafted on this pack, in send order. */
      route_kinds: string[];
      /** How many emails SEND IT will really send. */
      route_count: number;
    };
    captain_only: boolean;
  };
}

export function buildSesCockpitView(
  docket: SesCockpitDocket,
  displayedBinding?: {
    readiness_revision: string;
    dependency_generation: number;
  },
): SesCockpitView {
  // ONE-WAY by construction: the blocker list only ever GROWS here and `clean`
  // is only ever forced false, so a card can never become more approvable by
  // this path. Keep it that way — see existingCardMoneyRefusal.
  const verdict = sesVerdictWithExistingMoney(
    evaluateSesMechanicalClean(docket.clean_input),
    docket.xero_binding?.status ?? null,
    docket.existing_card_money ?? null,
  );
  const stale = !!displayedBinding &&
    (displayedBinding.readiness_revision !== docket.readiness_revision ||
      displayedBinding.dependency_generation !== docket.dependency_generation);
  const xeroAuthorised = docket.xero_binding?.status === "AUTHORISED";
  const noAdditionalCharge =
    docket.clean_input.pricing_disposition === "no_additional_charge";
  const hardDecisionBlock = verdict.approval_band === "decision_blocked";
  // Option B: APPROVE INVOICE is permission to make an existing DRAFT real
  // (authorise/release), not permission to mint. Mint is create_ses_invoice_draft.
  const xeroIsDraft =
    String(docket.xero_binding?.status || "").toUpperCase() ===
      "DRAFT";
  const approveInvoice = !stale && !hardDecisionBlock &&
    !noAdditionalCharge &&
    verdict.checks.filter((item) => item.id !== "C11").every((item) =>
      item.passed
    ) &&
    !!docket.invoice_obligation_revision_id &&
    !!docket.xero_binding &&
    xeroIsDraft;
  const releaseProgress = docket.release_send_progress || { kind: "none" };
  const releaseBlocksSend = releaseSendProgressBlocksSend(releaseProgress);
  // A proved or released pack must never read as SEND_READY — that would invite
  // a second builder send of routes already on the ledger.
  const sendIt = !stale && !releaseBlocksSend && verdict.clean &&
    (xeroAuthorised || noAdditionalCharge);
  let status: SesCockpitView["status"];
  if (releaseProgress.kind === "released") {
    status = "RELEASED";
  } else if (releaseProgress.kind === "closeout_pending") {
    status = "CLOSEOUT_PENDING";
  } else if (releaseProgress.kind === "partially_released") {
    status = "PARTIALLY_RELEASED";
  } else if (stale || verdict.blockers.length > 0) {
    status = "HOLD";
  } else if (sendIt) {
    status = "SEND_READY";
  } else if (approveInvoice) {
    status = "INVOICE_CREATE_READY";
  } else {
    status = "PRE_XERO_DOCS_READY";
  }
  const releaseReason = describeReleaseSendProgress(releaseProgress);
  const statusReasons = [
    ...verdict.blockers.map((blocker) => blocker.fact),
    ...(releaseReason ? [releaseReason] : []),
  ];
  return {
    schema: "secureworks.makesafe.ses-review-cockpit/v1",
    section_order: SES_REVIEW_SECTION_ORDER,
    status,
    stale,
    verdict,
    caveats: docket.caveats || [],
    sections: {
      job_story: {
        job_id: docket.job_id,
        job_number: docket.job_number,
        attendance_cycle_ids: docket.attendance_cycle_ids,
        // Ticket 11 follow-up: the review pane needs the exact revision
        // identity on a FRESH page load (a signed-off card drops out of the
        // needs_review list, which was the only job->revision map the UI had),
        // so it can offer this back to get_ses_reviewable_pack. The server
        // still validates currency; nothing client-side decides a pack is
        // current.
        docket_revision_id: docket.docket_revision_id,
        docket_output_content_hash: docket.docket_output_content_hash ?? null,
      },
      status: {
        status,
        stale,
        reasons: statusReasons,
        caveats: docket.caveats || [],
        release_send_progress: releaseProgress,
      },
      insurance_work_order: docket.work_order || {
        state: "missing",
        fact: "The insurance work order is missing from this docket.",
      },
      family_evidence: docket.family_evidence,
      swms: docket.swms,
      money: {
        // When a live Xero draft/invoice is bound, surface that identity as the
        // bill. The local proposal stays available as internal pre-Xero state
        // but must not be presented alone as though it were the invoice.
        // pdf_content_hash is the stored real Xero PDF pointer (mint-time), and
        // a pointer is not a document: availability comes from the same
        // artifact/live-fetch projection the pack read uses, so this tab and
        // the pack agree. Never treat the proposal table as the bill.
        bound_invoice: docket.xero_binding
          ? {
            xero_invoice_id: docket.xero_binding.xero_invoice_id,
            invoice_number: docket.xero_binding.invoice_number,
            status: docket.xero_binding.status,
            total: docket.xero_binding.total ?? null,
            pdf_content_hash: docket.xero_binding.pdf_content_hash ?? null,
            pdf_available: docket.xero_invoice_pdf_available === true,
          }
          : null,
        xero: docket.xero_binding,
        local_invoice_proposal: docket.local_invoice_proposal,
      },
      email_drafts: docket.routes,
      crew_and_trade_visits: docket.crew_and_trade_visits,
      decision_controls: {
        approve_invoice: approveInvoice,
        send_it: sendIt,
      },
    },
    controls: {
      approve_invoice: {
        enabled: approveInvoice,
        label: "APPROVE INVOICE",
        plan:
          "Approve the existing Xero DRAFT for this exact obligation revision; authorise only if this approval explicitly includes authorise; then attach the real Xero PDF as a new docket revision.",
        // A disabled control with no stated reason teaches the operator to
        // distrust every disabled control. Once the money is committed this
        // button is CORRECTLY dead — a second approve would be a double charge —
        // so say that, rather than only greying out.
        disabled_reason: approveInvoice
          ? null
          : approveInvoiceDisabledReason(docket, {
            stale,
            xeroAuthorised,
            noAdditionalCharge,
            existingMoney: docket.existing_card_money ?? null,
          }),
      },
      send_it: {
        enabled: sendIt,
        label: "SEND IT",
        // Narrate the real pack (563 honesty). AJS report_invoice + photo packs
        // read as two routes; MLB three-route packs still read as three.
        plan: describeSesSendItPlan(docket.routes),
        disabled_reason: sendIt ? null : (releaseReason ||
          sendItDisabledReason(verdict, {
            stale,
            xeroAuthorised,
            noAdditionalCharge,
            xeroStatus: docket.xero_binding?.status ?? null,
          })),
        failed_checks: sesFailedChecks(verdict),
        route_kinds: sesRouteKindsOnPack(docket.routes),
        route_count: sesRouteKindsOnPack(docket.routes).length,
      },
      captain_only: !verdict.clean,
    },
  };
}

export interface SesReleaseMember {
  job_id: string;
  docket_revision_id: string;
  invoice_obligation_revision_id: string | null;
  attendance_cycle_ids: string[];
  readiness_revision: string;
  dependency_generation: number;
}

export interface SesReleaseRevisionPlan {
  release: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
}

export async function buildSesReleaseRevision(args: {
  org_id: string;
  members: SesReleaseMember[];
  routes: SesReviewRoute[];
  created_by: string;
  /** When set, selects AJS two-route vs universal three-route order. */
  builder_key?: string | null;
  /**
   * The family whose route requirement applies, and which routes that family
   * actually sends. These are the SAME inputs the cockpit's C11 uses, so the
   * path that lights APPROVE INVOICE and the path that builds the send obey one
   * ruling — see the note on `requiredSesRouteKinds`.
   *
   * All three are optional and default to the STRICT universal shape, so a
   * caller that has not been taught them gets exactly the old behaviour.
   */
  family?: string | null;
  photo_route_applicable?: boolean;
  report_route_applicable?: boolean;
  /** Canonical SES workflow hash included in the release content identity. */
  workflow_contract_hash?: string;
}): Promise<SesReleaseRevisionPlan> {
  if (args.members.length === 0) {
    throw new TypeError("release members required");
  }
  const routeByKind = new Map(
    args.routes.map((route) => [route.route_kind, route]),
  );
  // ONE producer of "what does this card owe". This used to call
  // sesReleaseRouteOrder directly, which is why a report-only card could clear
  // the cockpit, have its invoice AUTHORISED, and only then be refused here —
  // committed money with no send path. The photo exemption had the identical
  // gap. Requirement scope stays in requiredSesRouteKinds; never re-derive it.
  const requiredOrder = requiredSesRouteKinds(
    String(args.family || ""),
    args.photo_route_applicable !== false,
    args.builder_key,
    args.report_route_applicable !== false,
  );
  const orderedRoutes = requiredOrder.map((kind) => routeByKind.get(kind));
  const missingKinds = requiredOrder.filter((kind) => !routeByKind.has(kind));
  if (missingKinds.length > 0) {
    // Name the missing route AND the family's full requirement. The old message
    // recited a fixed three-route list, which on an exempt family named routes
    // that family never owed.
    throw new TypeError(
      `this release is missing the ${joinRouteKinds([...missingKinds])} ${
        missingKinds.length === 1 ? "route" : "routes"
      }; this family requires ${joinRouteKinds([...requiredOrder])}`,
    );
  }
  const members = args.members.map((member, ordinal) => ({
    ordinal,
    job_id: member.job_id,
    docket_revision_id: member.docket_revision_id,
    invoice_obligation_revision_id: member.invoice_obligation_revision_id,
    attendance_cycle_ids: [...new Set(member.attendance_cycle_ids)].sort(),
  }));
  const routes: Array<Record<string, unknown>> = [];
  for (let ordinal = 0; ordinal < orderedRoutes.length; ordinal++) {
    const route = orderedRoutes[ordinal]!;
    assertSesRouteRecipients(route);
    const bodyHash = await sesSha256(
      route.body,
      "SecureWorks:ses-release-route-body:v1\n",
    );
    const envelope = {
      route_kind: route.route_kind,
      recipients: route.recipients.map((value) => value.toLowerCase()).sort(),
      cc: (route.cc || []).map((value) => value.toLowerCase()).sort(),
      subject: route.subject,
      body_hash: bodyHash,
      attachment_hashes: route.attachment_hashes,
    };
    routes.push({
      ordinal,
      ...envelope,
      body: route.body,
      envelope_hash: await sesSha256(
        envelope,
        "SecureWorks:ses-release-route-envelope:v1\n",
      ),
      required: true,
    });
  }
  const releaseContent = {
    ...(args.workflow_contract_hash
      ? { workflow_contract_hash: args.workflow_contract_hash }
      : {}),
    docket_revision_ids: members.map((member) => member.docket_revision_id),
    obligation_revision_ids: members.map((member) =>
      member.invoice_obligation_revision_id
    ),
    route_kinds: routes.map((route) => route.route_kind),
    routes: routes.map((route) => ({
      recipients: route.recipients,
      cc: route.cc,
      subject: route.subject,
      body_hash: route.body_hash,
      attachment_hashes: route.attachment_hashes,
      envelope_hash: route.envelope_hash,
    })),
  };
  const contentHash = await sesSha256(
    releaseContent,
    "SecureWorks:ses-release-revision:v1\n",
  );
  return {
    release: {
      id: stableUuidFromSha256(contentHash),
      org_id: args.org_id,
      content_hash: contentHash,
      dependency_generation: Math.max(
        ...args.members.map((member) => member.dependency_generation),
      ),
      readiness_bindings: args.members.map((member) => ({
        job_id: member.job_id,
        readiness_revision: member.readiness_revision,
        dependency_generation: member.dependency_generation,
      })),
      created_by: args.created_by,
    },
    members,
    routes,
  };
}

export type SesApprovalAuth =
  | {
    mode: "jwt";
    user_id: string;
    role: string;
    operator_class: "shaun_clean" | "captain" | "admin_owner" | null;
  }
  | { mode: "api_key" | "routine"; user_id?: null };

export function canRecordSesApproval(
  auth: SesApprovalAuth,
  clean: SesMechanicalCleanResult,
): { allowed: boolean; captain_override: boolean; refusal?: string } {
  if (auth.mode !== "jwt") {
    return {
      allowed: false,
      captain_override: false,
      refusal:
        "Human approval requires an identified SES operator session; API keys and automation keys cannot approve.",
    };
  }
  const adminOwner = auth.role === "admin" || auth.role === "owner" ||
    auth.operator_class === "admin_owner";
  const captain = auth.operator_class === "captain" || adminOwner;
  if (clean.approval_band === "decision_blocked") {
    return {
      allowed: false,
      captain_override: false,
      refusal:
        "A required explicit decision is still missing, so no invoice or release approval can be recorded.",
    };
  }
  if (clean.clean && (auth.operator_class === "shaun_clean" || captain)) {
    return { allowed: true, captain_override: false };
  }
  if (!clean.clean && captain) {
    return { allowed: true, captain_override: true };
  }
  return {
    allowed: false,
    captain_override: false,
    refusal:
      "This docket is not mechanically clean, so Captain approval is required.",
  };
}
