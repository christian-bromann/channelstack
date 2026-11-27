import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Twilio's REST API in unit tests of live mode: accounts in memory, each an
 * Account SID, an Auth Token and its numbers, answering the calls the live backend makes in
 * Twilio's shapes, and recording each with whose account made it. A text from one account's number
 * to another number in the stub reaches it, as a message of its own (another SID) on the account
 * that owns that number. `agentReplies` sends the agent's answer, as the agent would.
 */
export interface TwilioStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly agent: Account;
  account(name: string, numbers: readonly string[]): Account;
  readonly calls: Array<{ method: string; path: string; as: string }>;
  /** Every message on every account, oldest first. */
  readonly messages: Message[];
  /** The agent's text to a number, sent from its account. */
  agentReplies(to: string, body: string): void;
  /** Refuse the next call to a path ending so, with Twilio's error. */
  failNext(path: string, code: number, status: number): void;
}

interface Account {
  name: string;
  sid: string;
  token: string;
  numbers: readonly string[];
  /** The credential a person's token is: `<Account SID>:<Auth Token>`. */
  credential: string;
}

interface Message {
  sid: string;
  account: string;
  from: string;
  to: string;
  body: string;
  direction: "inbound" | "outbound-api";
  status: string;
  created: number;
}

const HEX = "0123456789abcdef";
const sid = (prefix: string) => `${prefix}${randomString(32, HEX)}`;
const rfc2822 = (ms: number) => new Date(ms).toUTCString().replace(/GMT$/, "+0000");

/** `agentNumbers`: the agent's account's numbers, its own first; more for people on the same account. */
export function twilioStub(options: { agentNumbers?: readonly string[] } = {}): TwilioStub {
  const url = "https://twilio.stub";
  const accounts: Account[] = [];
  const messages: Message[] = [];
  const calls: TwilioStub["calls"] = [];
  const failures: Array<{ path: string; code: number; status: number }> = [];
  const account = (name: string, numbers: readonly string[]) => {
    const made = { name, sid: sid("AC"), token: randomString(32, HEX), numbers, credential: "" };
    made.credential = `${made.sid}:${made.token}`;
    accounts.push(made);
    return made;
  };
  const agent = account("agent", options.agentNumbers ?? ["+14155550100"]);
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refusal = (status: number, code: number, message: string) =>
    json({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }, status);
  const wire = (message: Message) => ({
    sid: message.sid,
    account_sid: message.account,
    from: message.from,
    to: message.to,
    body: message.body,
    status: message.status,
    direction: message.direction,
    error_code: null,
    num_segments: "1",
    num_media: "0",
    date_created: rfc2822(message.created),
    date_sent: rfc2822(message.created),
  });
  const owner = (number: string) => accounts.find((each) => each.numbers.includes(number));
  /** A text from a number, on its account, and the copy that reaches the other number's account. */
  const send = (from: Account, input: { from: string; to: string; body: string }) => {
    const created = Date.now();
    const out: Message = {
      sid: sid("SM"),
      account: from.sid,
      ...input,
      direction: "outbound-api",
      status: "delivered",
      created,
    };
    messages.push(out);
    const receiver = owner(input.to);
    if (receiver)
      messages.push({ ...out, sid: sid("SM"), account: receiver.sid, direction: "inbound", status: "received" });
    return out;
  };

  const handle = async (request: Request): Promise<Response> => {
    const target = new URL(request.url);
    const [, version, , accountSid, ...rest] = target.pathname.split("/");
    const decoded = Buffer.from(
      (request.headers.get("authorization") ?? "").replace(/^Basic /, ""),
      "base64",
    ).toString();
    const caller = accounts.find((each) => each.credential === decoded);
    calls.push({ method: request.method, path: `${target.pathname}${target.search}`, as: caller?.name ?? "nobody" });
    const failure = failures.findIndex((each) => target.pathname.endsWith(each.path));
    if (failure >= 0) {
      const [failed] = failures.splice(failure, 1);
      return refusal(failed?.status ?? 400, failed?.code ?? 0, "refused by the stub");
    }
    const account = accountSid?.replace(/\.json$/, "");
    if (version !== "2010-04-01" || !caller || account !== caller.sid) return refusal(401, 20003, "Authenticate");
    const path = rest.join("/");
    if (path === "") return json({ sid: caller.sid, status: "active", friendly_name: caller.name });
    if (path === "IncomingPhoneNumbers.json") {
      const wanted = target.searchParams.get("PhoneNumber");
      const numbers = caller.numbers.filter((number) => wanted === null || number === wanted);
      return json({
        incoming_phone_numbers: numbers.map((number) => ({
          phone_number: number,
          sid: sid("PN"),
          capabilities: { sms: true },
        })),
      });
    }
    if (path === "Messages.json" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const input = { from: form.get("From") ?? "", to: form.get("To") ?? "", body: form.get("Body") ?? "" };
      if (!caller.numbers.includes(input.from))
        return refusal(400, 21606, `The From phone number ${input.from} is not yours`);
      return json(wire(send(caller, input)), 201);
    }
    if (path === "Messages.json") {
      const { searchParams: query } = target;
      const listed = messages
        .filter((message) => message.account === caller.sid)
        .filter((message) => !query.has("To") || message.to === query.get("To"))
        .filter((message) => !query.has("From") || message.from === query.get("From"))
        .reverse();
      return json({ messages: listed.map(wire), page: 0, page_size: 100, next_page_uri: null });
    }
    const one = /^Messages\/(SM[0-9a-f]{32})\.json$/.exec(path);
    const message = messages.find((each) => each.sid === one?.[1] && each.account === caller.sid);
    if (!one || !message) return refusal(404, 20404, `The requested resource ${target.pathname} was not found`);
    if (request.method === "DELETE") {
      messages.splice(messages.indexOf(message), 1);
      return json(undefined, 204);
    }
    return json(wire(message));
  };

  return {
    url,
    fetch: (async (input: Request | string | URL, init?: RequestInit) =>
      handle(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch,
    agent,
    account,
    calls,
    messages,
    agentReplies: (to, body) => send(agent, { from: agent.numbers[0] as string, to, body }),
    failNext: (path, code, status) => failures.push({ path, code, status }),
  };
}
