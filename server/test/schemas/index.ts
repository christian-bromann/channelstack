/**
 * Each channel's own description of its API and webhooks, as checks: what the platform says about
 * an answer the fake gave, or a webhook it sent. The acceptance run holds every test to them
 * (`test/acceptance/schemas.setup.ts`); a channel's unit tests use them directly. A channel with
 * a pinned schema adds its entry here.
 */
import { restProblems, webhookProblems } from "./github.ts";
import { linearResponseProblems, linearWebhookProblems } from "./linear.ts";
import { resendResponseProblems, resendWebhookProblems } from "./resend.ts";

/** An API call as a fixture's `calls()` reads it. */
export interface CheckedCall {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly request?: unknown;
  readonly responseStatus: number;
  readonly response?: unknown;
}

export interface ChannelSchemas {
  /** What the platform's description says about one answer: nothing when it fits. */
  call(call: CheckedCall): string[];
  /** What it says about one webhook. */
  webhook(type: string, payload: unknown): string[];
  /**
   * Calls about nothing in a session, which every session reads (GitHub's App's own endpoints):
   * the fixture's read of them. The ones made since a test began are checked with it.
   */
  readonly sessionless?: "appCalls";
}

export const SCHEMAS: Readonly<Record<string, ChannelSchemas>> = {
  github: {
    call: (call) => restProblems(call.method, call.path, call.responseStatus, call.response),
    webhook: webhookProblems,
    sessionless: "appCalls",
  },
  linear: {
    call: (call) => linearResponseProblems(call.request as { query: string }, call.responseStatus, call.response),
    webhook: linearWebhookProblems,
  },
  resend: {
    call: (call) => resendResponseProblems(call.method, call.path, call.responseStatus, call.response),
    webhook: resendWebhookProblems,
  },
};
