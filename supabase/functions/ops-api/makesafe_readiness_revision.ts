export const MAKESAFE_READINESS_DOMAIN = "SecureWorks:make-safe-readiness:v1\n";
export const MAKESAFE_READINESS_ALGORITHM =
  "SecureWorks:make-safe-readiness:v1";

export type Sha256Revision = `sha256:${string}`;

export interface VersionedDependency {
  id: string;
  version: number;
  content_hash: Sha256Revision;
}

export interface ReadinessDependencyEnvelope {
  source_instruction: {
    id: string | null;
    version: number | null;
    content_hash: Sha256Revision | null;
  };
  lineage: {
    lineage_id: string | null;
    case_id: string | null;
    version: number | null;
    correction_hash: Sha256Revision | null;
    supersession_hash: Sha256Revision | null;
  };
  attendance: {
    attendance_cycle_ids: string[];
    current_attendance_cycle_id: string | null;
    attendance_cycle_set_hash: Sha256Revision | null;
    cycles: VersionedDependency[];
  };
  current_cycle: {
    assignments: VersionedDependency[];
    service_reports: VersionedDependency[];
    documents: VersionedDependency[];
    completion_photos: VersionedDependency[];
    portal_captures: VersionedDependency[];
  };
  family: {
    code: string | null;
    matrix_revision: string | null;
    matrix_content_hash: Sha256Revision | null;
  };
  pricing: {
    disposition: string | null;
    revision: string | null;
  };
  invoice_obligation: {
    id: string | null;
    revision: string | null;
  };
  docket: {
    revision_id: string | null;
    artifact_hash: Sha256Revision | null;
    manifest_hash: Sha256Revision | null;
  };
}

const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/;

function compareText(a: string, b: string): number {
  const left = Array.from(
    a.normalize("NFC"),
    (value) => value.codePointAt(0) as number,
  );
  const right = Array.from(
    b.normalize("NFC"),
    (value) => value.codePointAt(0) as number,
  );
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function sortedVersioned(
  rows: readonly VersionedDependency[],
): VersionedDependency[] {
  return [...rows].sort((a, b) => compareText(a.id, b.id));
}

export function normalizeReadinessEnvelope(
  envelope: ReadinessDependencyEnvelope,
): ReadinessDependencyEnvelope {
  return {
    source_instruction: { ...envelope.source_instruction },
    lineage: { ...envelope.lineage },
    attendance: {
      ...envelope.attendance,
      attendance_cycle_ids: [...envelope.attendance.attendance_cycle_ids]
        .map((id) => id.normalize("NFC"))
        .sort(compareText),
      cycles: sortedVersioned(envelope.attendance.cycles),
    },
    current_cycle: {
      assignments: sortedVersioned(envelope.current_cycle.assignments),
      service_reports: sortedVersioned(envelope.current_cycle.service_reports),
      documents: sortedVersioned(envelope.current_cycle.documents),
      completion_photos: sortedVersioned(
        envelope.current_cycle.completion_photos,
      ),
      portal_captures: sortedVersioned(
        envelope.current_cycle.portal_captures,
      ),
    },
    family: { ...envelope.family },
    pricing: { ...envelope.pricing },
    invoice_obligation: { ...envelope.invoice_obligation },
    docket: { ...envelope.docket },
  };
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError(`${path} must be a finite base-10 integer`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${
      value.map((item, index) => canonicalValue(item, `${path}[${index}]`))
        .join(",")
    }]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    for (const key of keys) {
      if (record[key] === undefined) {
        throw new TypeError(
          `${path}.${key} must be explicit null, not undefined`,
        );
      }
    }
    return `{${
      keys.map((key) =>
        `${JSON.stringify(key.normalize("NFC"))}:${
          canonicalValue(record[key], `${path}.${key}`)
        }`
      ).join(",")
    }}`;
  }
  throw new TypeError(`${path} contains unsupported ${typeof value}`);
}

export function canonicalReadinessJson(
  envelope: ReadinessDependencyEnvelope,
): string {
  return canonicalValue(normalizeReadinessEnvelope(envelope), "$");
}

function validateVersioned(
  name: string,
  rows: readonly VersionedDependency[],
  errors: string[],
) {
  for (const row of rows) {
    if (!row.id) errors.push(`${name} dependency id is required`);
    if (!Number.isSafeInteger(row.version) || row.version < 1) {
      errors.push(`${name}:${row.id || "(blank)"} version must be >= 1`);
    }
    if (!SHA256_REVISION.test(row.content_hash)) {
      errors.push(`${name}:${row.id || "(blank)"} content_hash is invalid`);
    }
  }
}

export function readinessDependencyErrors(
  envelope: ReadinessDependencyEnvelope,
): string[] {
  const errors: string[] = [];
  const source = envelope.source_instruction;
  if (!source.id) errors.push("source instruction id is required");
  if (!Number.isSafeInteger(source.version) || Number(source.version) < 1) {
    errors.push("source instruction version must be >= 1");
  }
  if (!source.content_hash || !SHA256_REVISION.test(source.content_hash)) {
    errors.push("source instruction content_hash is invalid");
  }
  const lineage = envelope.lineage;
  if (!lineage.lineage_id || !lineage.case_id) {
    errors.push("lineage and case identity are required");
  }
  if (!Number.isSafeInteger(lineage.version) || Number(lineage.version) < 1) {
    errors.push("lineage version must be >= 1");
  }
  if (
    !lineage.correction_hash ||
    !SHA256_REVISION.test(lineage.correction_hash)
  ) {
    errors.push("lineage correction_hash is invalid");
  }
  if (
    !lineage.supersession_hash ||
    !SHA256_REVISION.test(lineage.supersession_hash)
  ) {
    errors.push("lineage supersession_hash is invalid");
  }
  if (
    !envelope.attendance.current_attendance_cycle_id ||
    !envelope.attendance.attendance_cycle_ids.includes(
      envelope.attendance.current_attendance_cycle_id,
    )
  ) {
    errors.push("current attendance cycle is absent from the cycle set");
  }
  if (
    !envelope.attendance.attendance_cycle_set_hash ||
    !SHA256_REVISION.test(envelope.attendance.attendance_cycle_set_hash)
  ) {
    errors.push("attendance cycle set hash is invalid");
  }
  validateVersioned("attendance_cycle", envelope.attendance.cycles, errors);
  validateVersioned(
    "assignment",
    envelope.current_cycle.assignments,
    errors,
  );
  validateVersioned(
    "service_report",
    envelope.current_cycle.service_reports,
    errors,
  );
  validateVersioned("document", envelope.current_cycle.documents, errors);
  validateVersioned(
    "completion_photo",
    envelope.current_cycle.completion_photos,
    errors,
  );
  validateVersioned(
    "portal_capture",
    envelope.current_cycle.portal_captures,
    errors,
  );
  if (
    !envelope.family.code || !envelope.family.matrix_revision ||
    !envelope.family.matrix_content_hash ||
    !SHA256_REVISION.test(envelope.family.matrix_content_hash)
  ) {
    errors.push("family matrix identity is incomplete");
  }
  if (!envelope.pricing.disposition || !envelope.pricing.revision) {
    errors.push("pricing disposition revision is incomplete");
  }
  if (
    (envelope.invoice_obligation.id === null) !==
      (envelope.invoice_obligation.revision === null)
  ) {
    errors.push(
      "invoice obligation id and revision must both be null or present",
    );
  }
  if (
    (envelope.docket.revision_id === null) !==
      (envelope.docket.artifact_hash === null)
  ) {
    errors.push(
      "docket revision and artifact hash must both be null or present",
    );
  }
  return errors;
}

export async function computeMakesafeReadinessRevision(
  envelope: ReadinessDependencyEnvelope,
): Promise<Sha256Revision> {
  const bytes = new TextEncoder().encode(
    MAKESAFE_READINESS_DOMAIN + canonicalReadinessJson(envelope),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}

export async function computeAttendanceCycleSetHash(
  attendanceCycleIds: readonly string[],
): Promise<Sha256Revision> {
  const canonicalIds = [...new Set(attendanceCycleIds)]
    .map((id) => id.normalize("NFC"))
    .sort(compareText);
  const bytes = new TextEncoder().encode(
    `SecureWorks:make-safe-attendance-cycle-set:v1\n${
      canonicalValue(canonicalIds, "$")
    }`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${
    Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}

export function isSha256Revision(value: unknown): value is Sha256Revision {
  return typeof value === "string" && SHA256_REVISION.test(value);
}
