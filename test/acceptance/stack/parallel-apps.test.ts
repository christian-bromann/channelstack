import { describe, expect, test } from "vitest";

// Exit check 12.10: parallel sessions stay apart with two apps (decision 0027). Twenty copies at
// once, each with my-agent and `coder` in a channel of its own; each copy sees only its own.
const COPIES = 20;

let posted = 0;
let release: () => void = () => {};
const everyonePosted = new Promise<void>((resolve) => {
  release = resolve;
});

describe(`${COPIES} copies of a two-app channel in parallel`, () => {
  test.concurrent.for(Array.from({ length: COPIES }, (_, index) => index + 1))(
    "copy %i gets its own answer from the app it asked, and sees nothing of the others",
    async (copy, { slack }) => {
      const coder = await slack.createApp({ name: "coder" });
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app, coder] });
      const msg = await ana.say(`@coder what's 2 + 2? (copy ${copy})`, { channel });
      posted += 1;
      if (posted === COPIES) release();
      await everyonePosted;

      await expect(msg.thread).toHaveRepliesFrom(coder, { count: 1 });
      await expect(msg.thread).not.toHaveReplyFrom(slack.app);

      // Every delivery of this session, to either app, is about this copy's channel.
      const deliveries = await slack.deliveries();
      expect(new Set(deliveries.map((delivery) => delivery.app))).toEqual(new Set(["my-agent", "coder"]));
      for (const delivery of deliveries) {
        const event = (delivery.payload as { event: { channel?: string; user?: string; text?: string } }).event;
        expect(event.channel).toBe(channel.id);
        if (event.user === ana.id) expect(event.text).toContain(`(copy ${copy})`);
      }
    },
  );
});
