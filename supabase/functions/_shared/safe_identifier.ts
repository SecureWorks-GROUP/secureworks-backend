// Identifiers that may leave a function in a reply or a stored row.
//
// Provider replies and exceptions carry free text: Graph's error message,
// recipient addresses, SQL detail, a stack. None of it may reach a response or
// a stored error column. What may pass is a short machine identifier (a code, a
// state, an error class name) or a provider id (a Graph message id, an
// internetMessageId, a GHL message id), and only when it has the shape of one,
// so free text can never ride along under one of those names.

/** A code, state or error name: letters, digits and _ . : - only, 1 to 64 long. */
export const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A provider id: no spaces or quotes, 1 to 256 long (Graph ids, <id@host>). */
export const SAFE_PROVIDER_ID = /^[A-Za-z0-9<>@._:+=\/-]{1,256}$/;

export function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

export function safeProviderId(value: unknown): string | null {
  return typeof value === "string" && SAFE_PROVIDER_ID.test(value) ? value : null;
}

function httpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

export type SafeErrorFacts = {
  error_name: string | null;
  provider_status?: number;
  provider_code?: string;
};

/**
 * What may be said about a thrown error: its class name, and the provider
 * status and code it carries (on itself or under `context`), each only when it
 * has a safe shape. Never its message.
 */
export function safeErrorFacts(error: unknown): SafeErrorFacts {
  const e = (error && typeof error === "object") ? error as Record<string, unknown> : null;
  const context = (e?.context && typeof e.context === "object") ? e.context as Record<string, unknown> : null;
  const status = httpStatus(context?.provider_status) ?? httpStatus(e?.status);
  const code = safeIdentifier(context?.provider_code) ?? safeIdentifier(e?.code);
  return {
    error_name: safeIdentifier(e?.name),
    ...(status !== null ? { provider_status: status } : {}),
    ...(code !== null ? { provider_code: code } : {}),
  };
}

/** A one-line, text-free description of a thrown error for a stored error column. */
export function safeErrorLine(error: unknown): string {
  const facts = safeErrorFacts(error);
  const parts = [facts.error_name ?? "error"];
  if (facts.provider_status !== undefined) parts.push(`status=${facts.provider_status}`);
  if (facts.provider_code !== undefined) parts.push(`code=${facts.provider_code}`);
  return parts.join(" ");
}
