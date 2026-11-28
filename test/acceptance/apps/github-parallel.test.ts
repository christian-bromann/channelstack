import { describe, expect, test } from "vitest";

// Exit check 12.10: parallel sessions stay apart with two GitHub Apps (decision 0027). Twenty
// copies at once, each with a repository both Apps are installed on; each sees only its own.
const COPIES = 20;

// Every copy has commented before any looks for an answer, so the twenty sessions really overlap.
let commented = 0;
let release: () => void = () => {};
const everyoneCommented = new Promise<void>((resolve) => {
  release = resolve;
});

describe(`${COPIES} copies of a two-App repository in parallel`, () => {
  test.concurrent.for(Array.from({ length: COPIES }, (_, index) => index + 1))(
    "copy %i gets its own answer from the App it asked, and sees nothing of the others",
    { timeout: 90_000 },
    async (copy, { github }) => {
      const coder = await github.createApp({ name: "coder" });
      const ana = await github.createUser({ login: "ana" });
      const repo = await github.createRepo({ collaborators: [ana], apps: [github.app, coder] });
      const issue = await ana.openIssue({ title: `Login fails (copy ${copy})` }, { repo });

      await ana.comment(`@coder can you triage this? (copy ${copy})`, { issue });
      commented += 1;
      if (commented === COPIES) release();
      await everyoneCommented;

      // Probot spaces an installation's writes about a second apart, as it does against GitHub, so twenty
      // answers from one App take it tens of seconds.
      await expect(issue).toHaveCommentFrom(coder, { text: /triage/, timeout: "75s" });
      // One answer, here: one installation token reaches every copy's repository, so an App that
      // answered another copy's mention in this issue would leave two here and none there.
      await expect(issue).toHaveCommentsFrom(coder, { count: 1 });
      await expect(issue).not.toHaveCommentFrom(github.app);

      // Both Apps were told of Ana's comment, and every delivery of this session is about its repository.
      const deliveries = await github.deliveries();
      expect(new Set(deliveries.map((delivery) => delivery.app))).toEqual(new Set(["my-agent", "coder"]));
      for (const delivery of deliveries) {
        // GitHub's payloads carry the repository's numeric id; the handle has it as text.
        const payload = delivery.payload as {
          repository?: { id: number };
          comment?: { body: string; user: { login: string } };
        };
        if (payload.repository) expect(String(payload.repository.id)).toBe(String(repo.id));
        if (payload.comment?.user.login === "ana") expect(payload.comment.body).toContain(`(copy ${copy})`);
      }
    },
  );
});
