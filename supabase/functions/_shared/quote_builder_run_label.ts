// A quote builder client PDF is a job_documents `quote` row keyed by its own
// chain: run_label `qb:<chain_id>` (scope chain = job id, each variation its
// own chain). That keeps it out of the job-wide live unsent quote that
// ghl-proxy prepare_quote reuses (ux_job_docs_live_unsent_quote), lets a scope
// and every variation stay live side by side, and marks it as no send-quote
// party: it is never sent, never accepted and never required for acceptance.
// Contract: docs/quote-builder-contract.md.

export const QUOTE_BUILDER_RUN_LABEL_PREFIX = "qb:";

export function quoteBuilderRunLabel(chainId: string): string {
  return `${QUOTE_BUILDER_RUN_LABEL_PREFIX}${chainId}`;
}

export function isQuoteBuilderRunLabel(runLabel: unknown): boolean {
  return typeof runLabel === "string" &&
    runLabel.startsWith(QUOTE_BUILDER_RUN_LABEL_PREFIX);
}
