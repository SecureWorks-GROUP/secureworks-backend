import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";

export function completionPackReviewVisitHtml(): string {
  return `<span style="font-size:12px;">Or visit: <strong style="color:#F15A29">${GOOGLE_REVIEW_URL}</strong></span>`;
}

export function completionPackReviewPdfLine(): string {
  return `Review us on Google: ${GOOGLE_REVIEW_URL}`;
}
