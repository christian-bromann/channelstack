import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/** Where the message a delivery tells the agent about is (a Linear webhook or agent session event: who wrote it, the team, the issue, and the comment): what a model call answering it is about. */
export const linearPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["data.userId", "data.creatorId", "agentSession.creatorId", "agentSession.creator.id"],
    conversation: ["data.teamId", "data.issue.teamId", "agentSession.issue.teamId"],
    thread: ["data.issueId", "agentSession.issueId", "data.issue.id"],
    message: ["data.id", "agentActivity.id"],
  });
