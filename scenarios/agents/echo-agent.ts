/**
 * The reference agent for the echo platform: a plain HTTP program with no channelstack code in it.
 * It verifies each delivery's signature, acknowledges, and answers "echo: <text>" through the
 * provider API. Configuration comes from `channelstack env`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const { ECHO_API_URL, ECHO_APP_TOKEN, ECHO_SIGNING_SECRET, PORT } = process.env;
if (!ECHO_API_URL || !ECHO_APP_TOKEN || !ECHO_SIGNING_SECRET || !PORT) {
  throw new Error("echo-agent needs ECHO_API_URL, ECHO_APP_TOKEN, ECHO_SIGNING_SECRET and PORT");
}

const REPLAY_WINDOW_S = 300;

function verified(body: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > REPLAY_WINDOW_S) return false;
  const expected = Buffer.from(
    `v1=${createHmac("sha256", ECHO_SIGNING_SECRET as string)
      .update(`v1:${timestamp}:${body}`)
      .digest("hex")}`,
  );
  const presented = Buffer.from(signature);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

async function reply(room: string, text: string): Promise<void> {
  const response = await fetch(`${ECHO_API_URL}/api/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${ECHO_APP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ room, text }),
  });
  if (!response.ok) console.error(`echo-agent: messages.create failed with ${response.status}`);
}

createServer((request, response) => {
  if (request.method === "GET") return void response.writeHead(200).end("ok");
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const header = (name: string) => [request.headers[name]].flat()[0];
    if (!verified(body, header("x-echo-request-timestamp"), header("x-echo-signature"))) {
      return void response.writeHead(401).end("bad signature");
    }
    response.writeHead(200).end("ok");
    const event = JSON.parse(body) as {
      type: string;
      message: { room: string; text: string; author: { kind: string } };
    };
    // Ignore the app's own messages, the way a real agent has to.
    if (event.type === "message.created" && event.message.author.kind === "user") {
      void reply(event.message.room, `echo: ${event.message.text}`);
    }
  });
}).listen(Number(PORT), "127.0.0.1");
