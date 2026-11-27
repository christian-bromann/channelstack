import { openApiChecks } from "./openapi.ts";
import description from "./resend-openapi.json" with { type: "json" };

/**
 * Resend's own description of its REST API and webhooks (`resend/resend-openapi`, pinned by
 * `scripts/pinned-schema.ts`), as validators. Exit check 8.3 holds every answer and every webhook
 * of the fake to them.
 */
const checks = openApiChecks(description as Record<string, unknown>, { name: "Resend" });

/** What Resend's description says about one answer of the API: nothing when it fits. */
export const resendResponseProblems = checks.response;

/** What it says about one webhook. */
export function resendWebhookProblems(type: string, payload: unknown): string[] {
  return checks.schema(
    ["webhooks", type, "post", "requestBody", "content", "application/json", "schema"],
    payload,
    `webhook ${type}`,
  );
}
