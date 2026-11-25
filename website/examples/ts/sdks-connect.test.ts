// @show:start
import { connect } from "channelstack/client";

await using client = await connect({ mode: "auto" });
await using session = await client.openSession({ name: "example" });

const slack = await session.slack();
const ana = await slack.createUser({ name: "Ana" });
const channel = await slack.createChannel({ participants: [ana, slack.app] });

const msg = await ana.say("@my-agent hi", { channel });
const reply = await msg.thread.waitForReply({ from: "my-agent" });
console.log(reply.text);
// @show:end
