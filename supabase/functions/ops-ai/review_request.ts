import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";

export function opsAiReviewRequestMessage(clientName?: string | null): string {
  return `Hi ${
    (clientName || "").split(" ")[0]
  }, thanks for choosing SecureWorks for your project! We'd really appreciate a quick Google review — it helps other Perth homeowners find quality builders. Here's the link: ${GOOGLE_REVIEW_URL}`;
}
