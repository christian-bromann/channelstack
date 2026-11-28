import { placeFrom } from "../../core/attribution/place.ts";
import type { MessagePlace } from "../../core/router/index.ts";

/** Where the message a delivery tells the agent about is (a GitHub webhook: who sent it, the repository, the issue or pull request, and the comment or review): what a model call answering it is about. */
export const githubPlace = (body: string): Omit<MessagePlace, "channel"> | undefined =>
  placeFrom(body, {
    from: ["sender.id"],
    conversation: ["repository.id"],
    thread: ["issue.number", "pull_request.number"],
    message: ["comment.id", "review.id", "issue.id", "pull_request.id"],
  });
