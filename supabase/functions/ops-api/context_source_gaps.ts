// Existing CTX-T20 standing gaps, shared by staff Overview and agent story reads.
// Remove a gap only with evidence that the corresponding capture is complete.
// These two gaps are not an exhaustive account/lane coverage measurement.
export const CONTEXT_NOT_SEEN = [
  {
    key: "material_orders",
    text: "Material orders and deliveries are not recorded here.",
  },
  {
    key: "crew_tasks_and_crm_notes",
    text: "Crew tasks and GHL notes are not captured.",
  },
] as const;

export function storySourceCoverage() {
  return {
    version: "context-source-coverage-v1",
    state: "partial",
    not_seen: CONTEXT_NOT_SEEN.map((gap) => ({ ...gap })),
    limitation:
      "These are standing source gaps, not a measured inventory of all accounts or readers. Zero unread placed records does not establish complete capture.",
  };
}
