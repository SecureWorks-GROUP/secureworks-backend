// Quote v2: shared text and money formatting for customer pages. Pure.

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

export function money(value: number | string): string {
  return AUD.format(Number(value));
}
