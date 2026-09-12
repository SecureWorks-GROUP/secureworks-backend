export type CancellationMatchedForm =
  | "subject"
  | "direct_imperative"
  | "passive_notice"
  | null;

export interface CancellationClassification {
  isCancellation: boolean;
  matchedForm: CancellationMatchedForm;
}

const TARGET = String
  .raw`(?:it|this|the|our|existing|current)?\s*(?:make[\s-]*safe|work\s*order|wo|job|instruction|request)?`;
const SUBJECT_NOTICE_RE = new RegExp(
  String
    .raw`(?:^|[\s:–—-])(?:cancelled|canceled|cancellation|withdrawn|voided|rescinded)\b(?:\s+${TARGET})?`,
  "i",
);
const SUBJECT_IMPERATIVE_RE = new RegExp(
  String
    .raw`(?:^|[\s:–—-])(?:please\s+|kindly\s+)?(?:cancel|withdraw|void|rescind)\b(?:\s+${TARGET})?`,
  "i",
);
const DIRECT_IMPERATIVE_RE = new RegExp(
  String
    .raw`(?:^|[.!?\n]\s*)(?:please\s+|kindly\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:(?:cancel)\s+(?:it|(?:(?:this|the|our|existing|current)\s+)?(?:make[\s-]*safe|work\s*order|wo|job|instruction|request))|(?:withdraw|void|rescind)\s+(?:(?:this|the|our|existing|current)\s+)(?:make[\s-]*safe|work\s*order|wo|job|instruction|request))(?:\s+please)?(?:[.!?]|\s*$)`,
  "i",
);
const PASSIVE_NOTICE_RE = new RegExp(
  String
    .raw`(?:\b(?:the|this|our)?\s*(?:make[\s-]*safe|work\s*order|wo|job|instruction|request|it)\s+(?:is|has\s+been|was)\s+(?:cancelled|canceled|withdrawn|voided|rescinded)\b|\b(?:cancelled|canceled|withdrawn|voided|rescinded)\s+(?:make[\s-]*safe|work\s*order|wo|job|instruction|request)\b)`,
  "i",
);
const NEGATED_RE =
  /\b(?:do\s+not|don't|dont|never|not\s+to|no\s+need\s+to)\s+(?:cancel|withdraw|void|rescind)\b/i;
const POLICY_RE =
  /\b(?:cancellation|cancel|withdrawal|voiding)\s+(?:policy|policies|fee|fees|terms?|process|procedure|notice\s+period)\b/i;

export function currentMessageOnly(value: string | null | undefined): string {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (
      /^\s*(?:from|sent|to|subject):\s+/i.test(line) ||
      /^\s*-{2,}\s*(?:original message|forwarded message)\s*-{2,}\s*$/i.test(
        line,
      ) ||
      /^\s*>/.test(line)
    ) break;
    if (/^\s*(?:kind regards|regards|thanks),?\s*$/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function eligible(value: string): boolean {
  return !!value && !NEGATED_RE.test(value) && !POLICY_RE.test(value);
}

/**
 * Classifies a builder's current cancellation instruction. The runtime supplies
 * current-message text; this helper also stops at common quote/signature seams.
 */
export function classifyCancellation(input: {
  subject?: string | null;
  currentMessageText?: string | null;
}): CancellationClassification {
  const subject = currentMessageOnly(input.subject);
  if (
    eligible(subject) &&
    (SUBJECT_NOTICE_RE.test(subject) ||
      SUBJECT_IMPERATIVE_RE.test(subject) ||
      DIRECT_IMPERATIVE_RE.test(subject) ||
      PASSIVE_NOTICE_RE.test(subject))
  ) {
    return { isCancellation: true, matchedForm: "subject" };
  }

  const body = currentMessageOnly(input.currentMessageText);
  if (!eligible(body)) {
    return { isCancellation: false, matchedForm: null };
  }
  if (DIRECT_IMPERATIVE_RE.test(body)) {
    return { isCancellation: true, matchedForm: "direct_imperative" };
  }
  if (PASSIVE_NOTICE_RE.test(body)) {
    return { isCancellation: true, matchedForm: "passive_notice" };
  }
  return { isCancellation: false, matchedForm: null };
}
