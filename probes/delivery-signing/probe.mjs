// Local probes: the fakes sign and shape deliveries the way the platforms do.
// Each probe drives the platform's own official receiver/verifier with requests channelstack would send.
import crypto from "node:crypto";
import bolt from "@slack/bolt";
import { Webhooks } from "@octokit/webhooks";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { signWebhookPayload, verifyWebhookSignature } from "@notionhq/client";

const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); };
const secret = () => crypto.randomBytes(24).toString("hex");

// ---------------------------------------------------------------- Slack (Bolt HTTP receiver)
async function slack() {
  const SIGNING = secret();
  const port = 39000 + Math.floor(Math.random() * 500);
  const seen = {};
  const app = new bolt.App({ signingSecret: SIGNING, authorize: async () => ({ botToken: "xoxb-probe", botUserId: "UBOT", botId: "B1" }) });
  app.event("app_mention", async ({ event, context }) => { seen.mention = { text: event.text, retryNum: context.retryNum, retryReason: context.retryReason }; });
  app.action("approve", async ({ ack, body }) => { await ack(); seen.action = body.user.id; });
  app.view("deploy_modal", async ({ ack }) => { await ack({ response_action: "errors", errors: { env: "Pick an environment" } }); seen.view = true; });
  app.command("/deploy", async ({ ack, command }) => { await ack({ text: `ok ${command.text}` }); seen.command = command.text; });
  app.event("agent_session_stopped", async ({ event }) => { seen.stopped = event.type; });
  await app.start(port);

  const sign = (body, ts, key = SIGNING) => "v0=" + crypto.createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex");
  const post = async (body, type, { ts = Math.floor(Date.now() / 1000), key, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/slack/events`, {
      method: "POST",
      headers: { "content-type": type, "x-slack-request-timestamp": String(ts), "x-slack-signature": sign(body, ts, key), ...headers },
      body,
    });
    return { status: r.status, text: await r.text() };
  };
  const form = (o) => new URLSearchParams(o).toString();
  const evt = (event) => JSON.stringify({ type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: "Ev" + crypto.randomUUID(), event_time: Math.floor(Date.now() / 1000), event });

  let r = await post(evt({ type: "app_mention", user: "U1", text: "<@UBOT> deploy", channel: "C1", ts: "1.1" }), "application/json");
  record("S1 synthetic event_callback (JSON) accepted", r.status === 200 && seen.mention?.text === "<@UBOT> deploy", `status ${r.status}`);

  r = await post(form({ payload: JSON.stringify({ type: "block_actions", user: { id: "U2" }, team: { id: "T1" }, api_app_id: "A1", trigger_id: "fake.trigger", response_url: "https://channelstack.localhost/_channelstack/response/abc", actions: [{ action_id: "approve", block_id: "b", type: "button", value: "yes", action_ts: "1" }], container: { type: "message", message_ts: "1.1", channel_id: "C1" }, channel: { id: "C1" }, message: { ts: "1.1", text: "x" } }) }), "application/x-www-form-urlencoded");
  record("S2 synthetic block_actions (form) accepted", r.status === 200 && seen.action === "U2", `status ${r.status}`);

  r = await post(form({ payload: JSON.stringify({ type: "view_submission", user: { id: "U2" }, team: { id: "T1" }, api_app_id: "A1", view: { id: "V1", callback_id: "deploy_modal", state: { values: {} } } }) }), "application/x-www-form-urlencoded");
  let body = {}; try { body = JSON.parse(r.text); } catch {}
  record("S3 view_submission: response_action comes back in the HTTP body", r.status === 200 && body.response_action === "errors", `status ${r.status}, body ${r.text}`);

  r = await post(form({ command: "/deploy", text: "web staging", user_id: "U1", channel_id: "C1", team_id: "T1", api_app_id: "A1", trigger_id: "fake.trigger", response_url: "https://channelstack.localhost/_channelstack/response/def" }), "application/x-www-form-urlencoded");
  let cbody = {}; try { cbody = JSON.parse(r.text); } catch {}
  record("S4 synthetic slash command accepted; immediate reply in HTTP body", r.status === 200 && seen.command === "web staging" && cbody.text === "ok web staging", `status ${r.status}, body ${r.text}`);

  r = await post(evt({ type: "agent_session_stopped", user: "U1", channel: "D1" }), "application/json");
  record("S5 synthetic agent_session_stopped accepted", r.status === 200 && seen.stopped === "agent_session_stopped", `status ${r.status}`);

  r = await post(evt({ type: "app_mention", user: "U1", text: "x", channel: "C1", ts: "1.2" }), "application/json", { key: secret() });
  record("S6 wrong signing secret rejected", r.status === 401, `status ${r.status}`);

  r = await post(evt({ type: "app_mention", user: "U1", text: "x", channel: "C1", ts: "1.3" }), "application/json", { ts: Math.floor(Date.now() / 1000) - 6 * 60 });
  record("S7 stale timestamp (6 min) rejected", r.status === 401, `status ${r.status}`);

  seen.mention = undefined;
  r = await post(evt({ type: "app_mention", user: "U1", text: "retry", channel: "C1", ts: "1.4" }), "application/json", { headers: { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
  record("S8 forced retry headers reach the handler (context.retryNum)", r.status === 200 && seen.mention?.retryNum === 1 && seen.mention?.retryReason === "http_timeout", `retryNum ${seen.mention?.retryNum}, reason ${seen.mention?.retryReason}`);

  await app.stop();
}

// ---------------------------------------------------------------- GitHub (@octokit/webhooks)
async function github() {
  const SECRET = secret();
  const wh = new Webhooks({ secret: SECRET });
  let got;
  wh.on("check_run.requested_action", ({ payload }) => { got = payload.requested_action.identifier; });
  // The deliveries API returns request.payload as a parsed object, not the original bytes.
  const payloadObj = { action: "requested_action", requested_action: { identifier: "fix" }, check_run: { id: 1, name: "agent" }, repository: { id: 1, name: "web", full_name: "acme/web", owner: { login: "acme" } }, sender: { login: "ana" }, installation: { id: 9 } };
  const original = JSON.stringify(payloadObj, null, 2); // stand-in for GitHub's original bytes
  const originalSig = await wh.sign(original);
  const reserialized = JSON.stringify(payloadObj);
  let ok = false;
  try { ok = await wh.verify(reserialized, originalSig); } catch { ok = false; }
  record("G1 re-serialized delivery payload does NOT verify with the original signature", ok === false, `verify=${ok}`);
  const resigned = await wh.sign(reserialized);
  await wh.verifyAndReceive({ id: crypto.randomUUID(), name: "check_run", payload: reserialized, signature: resigned });
  record("G2 re-signed with the webhook secret: accepted and dispatched", got === "fix", `identifier ${got}`);
  let threw = false;
  try { await wh.verifyAndReceive({ id: crypto.randomUUID(), name: "check_run", payload: reserialized, signature: await new Webhooks({ secret: secret() }).sign(reserialized) }); } catch { threw = true; }
  record("G3 wrong secret rejected", threw, `threw=${threw}`);
}

// ---------------------------------------------------------------- Linear (@linear/sdk/webhooks)
async function linear() {
  const SECRET = secret();
  const client = new LinearWebhookClient(SECRET);
  const handler = client.createHandler();
  let signal;
  handler.on("AgentSessionEvent", (p) => { signal = p.agentActivity?.signal ?? p.agentActivity?.content?.signal ?? "none"; });
  const sign = (b) => crypto.createHmac("sha256", SECRET).update(b).digest("hex");
  const send = async (obj) => {
    const b = JSON.stringify(obj);
    const res = await handler(new Request("http://127.0.0.1/linear", { method: "POST", headers: { "content-type": "application/json", "linear-signature": sign(b), "linear-event": "AgentSessionEvent", "linear-delivery": crypto.randomUUID() }, body: b }));
    return res.status;
  };
  const base = { type: "AgentSessionEvent", action: "prompted", organizationId: "o1", oauthClientId: "c1", appUserId: "u1", agentSession: { id: "s1" }, agentActivity: { id: "a1", signal: "stop", content: { type: "prompt", body: "" } } };
  let st = await send({ ...base, webhookTimestamp: Date.now() });
  record("L1 synthetic prompted with signal stop accepted", st === 200 && signal === "stop", `status ${st}, signal ${signal}`);
  signal = undefined;
  st = await send({ ...base, webhookTimestamp: Date.now() - 61_000 });
  record("L2 recorded delivery resent after >60s rejected (webhookTimestamp is inside the signed body)", st !== 200 && signal === undefined, `status ${st}`);
  st = await send({ ...base, webhookTimestamp: Date.now() });
  record("L3 same delivery re-stamped and re-signed accepted", st === 200 && signal === "stop", `status ${st}`);
}

// ---------------------------------------------------------------- Notion (@notionhq/client)
async function notion() {
  const TOKEN = "secret_" + secret();
  const obj = { id: crypto.randomUUID(), type: "comment.created", timestamp: new Date().toISOString(), entity: { id: "c1", type: "comment" }, data: { page_id: "p1" } };
  const original = JSON.stringify(obj, null, 1);
  const sig = await signWebhookPayload({ body: original, verificationToken: TOKEN });
  record("N1 forwarded byte-identical body verifies", await verifyWebhookSignature({ body: original, signature: sig, verificationToken: TOKEN }), sig.slice(0, 14));
  const re = JSON.stringify(obj);
  record("N2 re-serialized body fails with the original signature", !(await verifyWebhookSignature({ body: re, signature: sig, verificationToken: TOKEN })), "");
  const resig = await signWebhookPayload({ body: re, verificationToken: TOKEN });
  record("N3 re-signed with the verification token verifies", await verifyWebhookSignature({ body: re, signature: resig, verificationToken: TOKEN }), "");
}

for (const f of [slack, github, linear, notion]) {
  try { await f(); } catch (e) { record(`${f.name} crashed`, false, String(e?.stack ?? e)); }
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.detail ? "  (" + r.detail + ")" : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
