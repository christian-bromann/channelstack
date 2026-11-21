// Probe: can channelstack stand in for Slack's Socket Mode endpoint for an agent that uses Socket Mode?
// channelstack answers apps.connections.open with its own ws:// URL, pushes envelopes, and reads the agent's acks.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import bolt from "@slack/bolt";

const out = [];
const rec = (id, ok, d = "") => out.push(`${ok ? "PASS" : "FAIL"}  ${id}${d ? "  (" + d + ")" : ""}`);
const port = 39600 + Math.floor(Math.random() * 300);
let openCalls = 0, sawAppToken = "";

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/apps.connections.open")) {
    openCalls++; sawAppToken = req.headers.authorization ?? "";
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/link` }));
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, user_id: "UBOT", bot_id: "B1", team_id: "T1" }));
});
const wss = new WebSocketServer({ server, path: "/link" });
const acks = new Map();
let sock;
const connected = new Promise((r) => wss.on("connection", (s) => {
  sock = s;
  s.send(JSON.stringify({ type: "hello", num_connections: 1, debug_info: { host: "channelstack" }, connection_info: { app_id: "A1" } }));
  s.on("message", (m) => { const j = JSON.parse(m.toString()); acks.get(j.envelope_id)?.(j); });
  r();
}));
await new Promise((r) => server.listen(port, r));

const seen = {};
const app = new bolt.App({
  socketMode: true,
  appToken: "xapp-1-probe",
  authorize: async () => ({ botToken: "xoxb-probe", botUserId: "UBOT", botId: "B1" }),
  clientOptions: { slackApiUrl: `http://127.0.0.1:${port}/api/` },
  logLevel: "error",
});
app.event("app_mention", async ({ event }) => { seen.mention = event.text; });
app.view("deploy_modal", async ({ ack }) => { await ack({ response_action: "errors", errors: { env: "Pick one" } }); });
app.command("/deploy", async ({ ack, command }) => { await ack({ text: `ok ${command.text}` }); });
await app.start();
await connected;
rec("K1 agent's Socket Mode client called apps.connections.open on channelstack with its app token", openCalls >= 1 && sawAppToken.includes("xapp-1-probe"), `calls ${openCalls}`);

const push = (type, payload, extra = {}) => new Promise((resolve) => {
  const id = crypto.randomUUID();
  const t = setTimeout(() => resolve(null), 3000);
  acks.set(id, (j) => { clearTimeout(t); resolve(j); });
  sock.send(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: type !== "events_api", retry_attempt: 0, retry_reason: "", ...extra }));
});

let a = await push("events_api", { type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: "Ev1", event_time: 1, event: { type: "app_mention", user: "U1", text: "hi", channel: "C1", ts: "1.1" } });
await new Promise((r) => setTimeout(r, 200));
rec("K2 events_api envelope delivered and acked within 3s", !!a && seen.mention === "hi", `ack ${JSON.stringify(a)}`);

a = await push("interactive", { type: "view_submission", user: { id: "U2" }, team: { id: "T1" }, api_app_id: "A1", view: { id: "V1", callback_id: "deploy_modal", state: { values: {} } } });
rec("K3 view_submission ack carries response_action in its payload", a?.payload?.response_action === "errors", `ack ${JSON.stringify(a)}`);

a = await push("slash_commands", { command: "/deploy", text: "web", user_id: "U1", channel_id: "C1", team_id: "T1", api_app_id: "A1", trigger_id: "t", response_url: "http://x" });
rec("K4 slash command ack carries the immediate reply", a?.payload?.text === "ok web", `ack ${JSON.stringify(a)}`);

await app.stop().catch(() => {});
wss.close(); server.close();
console.log(out.join("\n"));
process.exit(out.every((l) => l.startsWith("PASS")) ? 0 : 1);
