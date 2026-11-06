type GhlRead = (path: string, init: RequestInit) => Promise<unknown>;

// HighLevel's current duplicate lookup is GET, with query parameters and v3:
// https://marketplace.gohighlevel.com/docs/ghl/contacts/get-duplicate-contact/
// Keep email and phone independent so the mint can refuse conflicting matches.
export async function lookupScopeMintDuplicates(
  ghl: GhlRead,
  locationId: string,
  identity: { email: string | null; phone: string | null },
): Promise<unknown[]> {
  const lookups: Promise<unknown>[] = [];
  for (
    const [key, value] of [
      ["email", identity.email],
      ["number", identity.phone],
    ] as const
  ) {
    if (!value) continue;
    const query = new URLSearchParams({ locationId, [key]: value });
    lookups.push(ghl(`/contacts/search/duplicate?${query}`, {
      method: "GET",
      headers: { Version: "v3" },
      signal: AbortSignal.timeout(8000),
    }));
  }
  // At most two reads. A failed read must reject, never imply no match and
  // authorise a contact create while the provider is unavailable.
  return await Promise.all(lookups);
}
