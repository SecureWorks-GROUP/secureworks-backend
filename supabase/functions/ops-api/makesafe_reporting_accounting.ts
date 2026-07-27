// deno-lint-ignore-file no-explicit-any

export interface ReportingIntakeAccountingProof {
  checked: number;
  final: number;
  transient: number;
}

/**
 * Reporting is not successful merely because orchestration returned. It must
 * carry the runtime's durable per-source fate proof, including one typed issue
 * for every source still transient.
 */
export function assertReportingIntakeAccounting(
  intake: any,
): ReportingIntakeAccountingProof {
  if (intake?.mode !== "deterministic") {
    throw new Error(
      "SES reporting intake did not return deterministic evidence",
    );
  }
  const proof = intake?.evidence?.durable_source_fates;
  const checked = Number(proof?.checked);
  const final = Number(proof?.final);
  const transient = Number(proof?.transient);
  if (
    !Number.isInteger(checked) || checked < 0 ||
    !Number.isInteger(final) || final < 0 ||
    !Number.isInteger(transient) || transient < 0 ||
    final + transient !== checked
  ) {
    throw new Error("SES reporting intake source-fate assertion is incomplete");
  }
  return { checked, final, transient };
}
