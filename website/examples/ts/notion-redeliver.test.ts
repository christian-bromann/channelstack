import { expect, test } from "vitest";

test("Notion's deliveries, redelivered and forged", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({ title: "Roadmap", connections: [notion.app] });
  // @show:start
  const comment = await ana.comment("@my-agent hi", { page });

  await comment.delivery!.redeliver(); // the next attempt_number, signed again
  await comment.delivery!.resend({ badSignature: true }); // signed with the wrong token
  await expect(comment.delivery!).toBeRejected();
  // @show:end
});
