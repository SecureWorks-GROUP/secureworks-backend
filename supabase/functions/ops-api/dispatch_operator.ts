// deno-lint-ignore-file no-explicit-any
// Dispatch: the one lookup of the person an ops-key press names.
//
// A press made with the privileged ops key must name a real person by
// operator_email (desk rule: the person who gave the explicit yes). Slices 5,
// 6 and 7 each looked that person up their own way: two matched the typed
// email and its lower-case form exactly (a users row stored with capitals was
// refused), and one matched case-blind across every organisation and took the
// first row. This is now the only lookup:
//   - only users of the caller's organisation;
//   - case-blind, with the LIKE wildcards in the typed email escaped, so
//     "a_b@x" never matches "axb@x";
//   - then an exact case-blind compare, so a wildcard PostgREST reads in the
//     pattern (it turns * into %) can never pick a different person.
// It answers the email as users stores it, or null when no person matches.
// PostgREST returns errors, it does not throw: a failed read is thrown to the
// caller, which maps it to its own read-failed refusal.

export async function findDispatchOperator(
  client: any,
  orgId: string,
  typed: unknown,
): Promise<{ email: string } | null> {
  const raw = typeof typed === "string" ? typed.trim() : "";
  if (!raw || !orgId) return null;
  const pattern = raw.replace(/[\\%_*]/g, (c) => `\\${c}`);
  const { data, error } = await client.from("users")
    .select("id, email, org_id")
    .eq("org_id", orgId)
    .ilike("email", pattern);
  if (error) throw error;
  const match = (data || []).find((u: any) =>
    String(u?.org_id ?? "") === orgId &&
    String(u?.email ?? "").trim().toLowerCase() === raw.toLowerCase()
  );
  return match ? { email: String(match.email).trim() } : null;
}
