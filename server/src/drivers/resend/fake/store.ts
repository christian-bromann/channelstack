import { EmailStore } from "../../../core/email/store.ts";
import type { Registry } from "../../../core/registry/index.ts";
import type { ResendAppRecord, ResendEmailRecord } from "../world.ts";

/** The Resend fake's in-memory state: the email core's, for the agent's team and the other apps' teams. */
export class ResendStore extends EmailStore<ResendEmailRecord, ResendAppRecord> {
  constructor(registry: Registry) {
    super(registry, "resend", "Resend");
  }

  seed(app: ResendAppRecord): void {
    this.setApp(app);
  }
}
