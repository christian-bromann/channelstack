// @show:start
import { connect } from "channelstack/client";

await using client = await connect({ mode: "attach" });
await using session = await client.openSession();

const slack = await session.slack();
const ana = await slack.createUser({ name: "Ana" });
const msg = await ana.say("hi", { to: slack.app });
const reply = await msg.thread.waitForReply({ from: "my-agent" });
console.log(reply.text);
// The session closes here, and removes Ana and the DM.
// @show:end
