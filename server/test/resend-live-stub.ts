import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Resend's REST API in unit tests of live mode: teams in memory, each with a
 * key and a verified domain, that answer the calls the live backend makes in Resend's shapes, and
 * record each with whose key made it. An email one team sends to an address on another's domain is
 * received there. `agentReplies` sends the agent's team's answer, as the agent would.
 */
export interface ResendStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly agent: Team;
  team(name: string, domain: string): Team;
  readonly calls: Array<{ method: string; path: string; as: string }>;
  /** What every team sent, oldest first. */
  readonly sent: Email[];
  agentReplies(to: Email, text: string): void;
}

interface Team {
  name: string;
  key: string;
  domain: string;
  domainId: string;
}
interface Email {
  id: string;
  team: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
  at: string;
}

const hex = "0123456789abcdef";
const uuid = () =>
  `${randomString(8, hex)}-${randomString(4, hex)}-4${randomString(3, hex)}-a${randomString(3, hex)}-${randomString(12, hex)}`;
const key = () => `re_${randomString(8, "abcdefgh12345678")}_${randomString(24, "ABCDEFGHabcdefgh01234567")}`;
const address = (field: string) => (field.match(/<([^>]+)>/)?.[1] ?? field).toLowerCase();

export function resendStub(): ResendStub {
  const url = "https://resend.stub";
  const teams: Team[] = [];
  const sent: Email[] = [];
  const calls: ResendStub["calls"] = [];
  /** How often each sent email was read: Resend has it only after a moment. */
  const asked = new Map<string, number>();
  const team = (name: string, domain: string) => {
    const made = { name, key: key(), domain, domainId: uuid() };
    teams.push(made);
    return made;
  };
  const agent = team("agent", "agent.example.org");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const send = (
    by: Team,
    body: { from: string; to: string[]; subject: string; text?: string; headers?: Record<string, string> },
  ) => {
    const email: Email = {
      id: uuid(),
      team: by.name,
      from: body.from,
      to: body.to.map(address),
      subject: body.subject,
      text: body.text ?? "",
      messageId: `<${randomString(16, hex)}@${by.domain}>`,
      headers: Object.fromEntries(
        Object.entries(body.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      at: new Date().toISOString(),
    };
    sent.push(email);
    return email;
  };
  const stub: ResendStub = {
    url,
    agent,
    team,
    calls,
    sent,
    agentReplies(to, text) {
      send(agent, {
        from: `my-agent <my-agent@${agent.domain}>`,
        to: [address(to.from)],
        subject: `Re: ${to.subject}`,
        text,
        headers: { "In-Reply-To": to.messageId, References: to.messageId },
      });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      // The live client calls with a URL string and its options.
      const request = new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const by = teams.find((each) => `Bearer ${each.key}` === request.headers.get("authorization"));
      calls.push({ method: request.method, path, as: by?.name ?? "nobody" });
      if (!by) return json({ statusCode: 401, name: "missing_api_key", message: "Missing API key" }, 401);
      if (path === "/domains") {
        return json({
          object: "list",
          has_more: false,
          data: [
            {
              id: uuid(),
              name: by.domain,
              status: "verified",
              capabilities: { sending: "enabled", receiving: "enabled" },
            },
          ],
        });
      }
      if (request.method === "POST" && path === "/emails")
        return json({ id: send(by, (await request.json()) as Parameters<typeof send>[1]).id });
      const own = /^\/emails\/([^/]+)$/.exec(path);
      if (own && own[1] !== "receiving") {
        const email = sent.find((each) => each.id === own[1] && each.team === by.name);
        // As found against Resend: right after sending, the email isn't found yet (it may also come
        // back without a Message-ID for a moment, which the live world reads the same way).
        const reads = asked.get(own[1] ?? "") ?? 0;
        asked.set(own[1] ?? "", reads + 1);
        if (!email || reads === 0) return json({ statusCode: 404, name: "not_found", message: "Email not found" }, 404);
        return json({ object: "email", id: email.id, message_id: email.messageId });
      }
      const reached = (email: Email) => email.to.some((to) => to.endsWith(`@${by.domain}`));
      if (path === "/emails/receiving")
        return json({
          object: "list",
          has_more: false,
          data: sent.filter(reached).map(({ id, at }) => ({ id, created_at: at })),
        });
      const received = /^\/emails\/receiving\/([^/]+)$/.exec(path);
      const email = received && sent.find((each) => each.id === received[1] && reached(each));
      if (!email) return json({ statusCode: 404, name: "not_found", message: "Email not found" }, 404);
      return json({
        object: "email",
        id: email.id,
        from: email.from,
        to: email.to,
        subject: email.subject,
        message_id: email.messageId,
        created_at: email.at,
        text: email.text,
        html: null,
        headers: email.headers,
      });
    }) as typeof fetch,
  };
  return stub;
}
