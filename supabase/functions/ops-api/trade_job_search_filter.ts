// The text search of search_all_jobs (the Trade App job search and the
// invoice job picker) is a PostgREST or() filter built from what the trade
// typed. A comma, bracket, double quote or backslash in that text ends a
// condition or a group, and PostgREST answers 400, which reached the trade as
// a 500. Each of those characters becomes `_`, ilike's one-character
// wildcard, so "12 Smith St, Perth" still finds "12 Smith St, Perth".
// Only the or() string is changed; other reads keep the trade's text.

const OR_FILTER_RESERVED = /[,()"\\]/g;

export function tradeJobSearchOrTerm(q: string): string {
  return String(q || "").replace(OR_FILTER_RESERVED, "_");
}

export function tradeJobSearchOrFilter(q: string): string {
  const term = tradeJobSearchOrTerm(q);
  return [
    "job_number",
    "client_name",
    "site_suburb",
    "site_address",
  ].map((column) => `${column}.ilike.%${term}%`).join(",");
}
