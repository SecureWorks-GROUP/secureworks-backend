// ════════════════════════════════════════════════════════════
// SecureWorks Group telephony lines canon — see
// secureworks-docs/cio/operations/board/Evidence-Spine-JARVIS-Memory/
//   call-transcript-ingestion-activation/telephony-lines-canon.md
//
// Single source of truth for line attribution. Imported by the receiver's
// CallCompleted path AND the inbound-SMS normalizer (M0.5 U1b-a) so both stamp
// line_label + department from the ONE canon. Match body.to (inbound) or
// body.from (outbound) against E.164 OR local form.
// ════════════════════════════════════════════════════════════

export const TELEPHONY_LINES: Array<{ e164: string; local: string; line_label: string; department: string }> = [
  { e164: "+61489267776", local: "0489267776", line_label: "admin",          department: "ops"           },
  { e164: "+61489267772", local: "0489267772", line_label: "fencing",        department: "sales-fencing" },
  { e164: "+61489267774", local: "0489267774", line_label: "patios",         department: "sales-patios"  },
  { e164: "+61489267778", local: "0489267778", line_label: "fencing-mgmt",   department: "mgmt-fencing"  },
  { e164: "+61489267771", local: "0489267771", line_label: "shaun-ops-mgr",  department: "ops-mgr"       },
];

export function normalisePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  return digits.replace(/^0/, "61");
}

export function attributeLine(
  toRaw: string | null | undefined,
  fromRaw: string | null | undefined,
  direction: string | null | undefined,
): { line_label: string; department: string; matched_field: "to" | "from" | null } {
  const toN = normalisePhone(toRaw);
  const fromN = normalisePhone(fromRaw);
  // Inbound: client → us, so match `to` against our lines.
  // Outbound: us → client, so match `from` against our lines.
  // Default to checking both for robustness.
  const candidates: Array<["to" | "from", string]> = direction === "outbound"
    ? [["from", fromN], ["to", toN]]
    : [["to", toN], ["from", fromN]];
  for (const [field, n] of candidates) {
    if (!n) continue;
    for (const line of TELEPHONY_LINES) {
      if (n === normalisePhone(line.e164) || n === normalisePhone(line.local)) {
        return { line_label: line.line_label, department: line.department, matched_field: field };
      }
    }
  }
  return { line_label: "unknown", department: "unknown", matched_field: null };
}

/**
 * Resolve line_label + department for an inbound SMS. Two accepted inputs:
 *   - a destination NUMBER (GHL `to` / `toNumber`) → matched via attributeLine
 *     against the canon, exactly as CallCompleted attributes a call;
 *   - a static LABEL (`line: "fencing"`) hardcoded per-workflow when GHL exposes
 *     no destination merge field — matched against the canon's line_label.
 * Never guesses from the contact's own number. Absent both → unknown/unknown.
 */
export function attributeInboundLine(
  destinationNumber: string | null,
  staticLine: string | null,
): { line_label: string; department: string } {
  if (staticLine) {
    const label = staticLine.trim().toLowerCase();
    const known = TELEPHONY_LINES.find((l) => l.line_label === label);
    if (known) return { line_label: known.line_label, department: known.department };
    // An unrecognised static label is not trusted into the controlled vocabulary.
    return { line_label: "unknown", department: "unknown" };
  }
  if (destinationNumber) {
    // Match ONLY the destination (our line); pass null for `from` so the
    // client's own number can never accidentally attribute a line.
    const attr = attributeLine(destinationNumber, null, "inbound");
    return { line_label: attr.line_label, department: attr.department };
  }
  return { line_label: "unknown", department: "unknown" };
}
