import formats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { openApiChecks } from "./openapi.ts";
import description from "./resend-openapi.json" with { type: "json" };

/**
 * Resend's own description of its REST API and webhooks (`resend/resend-openapi`, pinned by
 * `scripts/pinned-schema.ts`), as validators. Exit check 8.3 holds every answer and every webhook
 * of the fake to them. The description is OpenAPI 3.1, so its schemas are JSON Schema 2020-12.
 */
type Json = Record<string, unknown>;

// The package's default export is the function itself under Node's ESM; its types say otherwise.
const addFormats = formats as unknown as (ajv: Ajv2020) => void;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(description as Json, "resend");
const checks = openApiChecks(ajv, "resend", description, "Resend");

/** What Resend's description says about one answer of the API: nothing when it fits. */
export const resendResponseProblems = checks.responseProblems;

/** What it says about one webhook. */
export function resendWebhookProblems(type: string, payload: unknown): string[] {
  const pointer = ["webhooks", type, "post", "requestBody", "content", "application/json", "schema"]
    .map(checks.pointerPart)
    .join("/");
  return checks.problemsOf(checks.schemaAt(pointer), payload, `webhook ${type}`);
}
