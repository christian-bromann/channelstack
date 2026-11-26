import { EmailStore } from "../../../core/email/store.ts";
import type { Registry } from "../../../core/registry/index.ts";
import type { ResendAppRecord, ResendEmailRecord } from "../world.ts";

/** The Resend fake's in-memory state: the email core's, for the agent's team. */
export class ResendStore extends EmailStore<ResendEmailRecord, ResendAppRecord> {
  constructor(registry: Registry) {
    super(registry, "resend");
  }

  seed(app: ResendAppRecord): void {
    this.setApp(app);
  }
}
