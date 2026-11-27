import type { Context, Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { googlePayloads, type MessageFormat } from "../payloads.ts";
import { GOOGLE_SECRETS } from "../secrets.ts";
import type { GmailLabelRecord, GmailMessageRecord, GoogleAppRecord } from "../world.ts";
import type { PushCertificates } from "./certs.ts";
import { type FakeGoogleWorld, GmailApiError, invalid, notFound } from "./world.ts";

/** An access token is good for an hour, less the second Google takes off. */
const TOKEN_LIFETIME_S = 3599;
/** Where a call keeps the mailbox its token is for. */
const MAILBOX = "channelstackGmailMailbox";
/** What the agent's client may do: read, label and send the mailbox's mail. */
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/** How long Google lets a client cache its certificates. */
const CERTS_MAX_AGE_S = 20_499;

/** A refusal in Google's error envelope. */
const errorAnswer = (error: GmailApiError): RestAnswer => ({
  body: googlePayloads.error(error.code, error.message, error.reason, error.status),
  sessions: [],
  status: error.code,
  headers: error.headers,
});

/** An OAuth refusal, as Google's token endpoint answers one: `{ error, error_description }`. */
const oauthRefusal = (status: number, error: string, description: string): RestAnswer => ({
  body: { error, error_description: description },
  sessions: [],
  status,
  headers: { "cache-control": "no-cache, no-store, max-age=0, must-revalidate" },
});

const answer = (body: unknown, messages: readonly GmailMessageRecord[] = [], world?: FakeGoogleWorld): RestAnswer => ({
  body,
  sessions: world ? messages.map((message) => world.store.messages.owner(message.id)) : [],
});

/** A page of a list, as Gmail pages: `maxResults` (default 100, at most 500) from `pageToken`. */
function page<T>(c: Context, items: readonly T[]): { items: T[]; next: string | undefined } {
  const max = Math.min(500, Math.max(1, Number(c.req.query("maxResults") ?? 100) || 100));
  const from = Number(c.req.query("pageToken") ?? 0) || 0;
  const window = items.slice(from, from + max);
  return { items: window, next: from + max < items.length ? String(from + max).padStart(20, "0") : undefined };
}

/** How far back `newer_than:` and `older_than:` count, per unit (`d`, `m`, `y`), in milliseconds. */
const RELATIVE_MS: Readonly<Record<string, number>> = { d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };
/** Gmail's search categories and the labels they are. */
const CATEGORIES: Readonly<Record<string, string>> = {
  primary: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

/**
 * `q` as Gmail's search reads it, for what agents search for: senders, subjects, states, labels,
 * dates and categories, `-` for not, and `OR` between two terms. A term with no operator is text.
 */
function matches(world: FakeGoogleWorld, message: GmailMessageRecord, q: string, now: number): boolean {
  const email = world.emailOf(message);
  const words = q.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S)+/g) ?? [];
  // `a OR b`: one of them. Every other term must hold.
  const groups: string[][] = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string;
    if (word === "OR" && groups.length > 0 && at + 1 < words.length) groups.at(-1)?.push(words[++at] as string);
    else groups.push([word]);
  }
  const inAddresses = (mailboxes: readonly { address: string; name: string }[], value: string) =>
    mailboxes.some((mailbox) => `${mailbox.name} ${mailbox.address}`.toLowerCase().includes(value));
  const holds = (term: string) => {
    const negated = term.startsWith("-");
    const [, operator, rawValue] = /^-?(?:(\w+):)?(.*)$/.exec(term) ?? [];
    const value = (rawValue ?? "").replace(/^"|"$/g, "").toLowerCase();
    let hit: boolean;
    switch (operator) {
      case "from":
        hit = inAddresses([email.from], value);
        break;
      case "to":
        hit = inAddresses(email.to, value);
        break;
      case "cc":
        hit = inAddresses(email.cc, value);
        break;
      case "subject":
        hit = email.subject.toLowerCase().includes(value);
        break;
      case "rfc822msgid":
        hit = email.messageId.toLowerCase().includes(value);
        break;
      case "is":
        hit =
          value === "read"
            ? !message.labels.includes("UNREAD")
            : message.labels.includes(value === "unread" ? "UNREAD" : value.toUpperCase());
        break;
      case "in":
      case "label":
        hit = value === "anywhere" || message.labels.some((label) => label.toLowerCase() === value);
        if (!hit && operator === "label") {
          const { labels } = world.store.mailbox(message.mailbox);
          hit = message.labels.some((label) => labels.get(label)?.name.toLowerCase() === value);
        }
        break;
      case "newer_than":
      case "older_than": {
        const [, count = "0", unit = "d"] = /^(\d+)([dmy])$/.exec(value) ?? [];
        const since = now - Number(count) * (RELATIVE_MS[unit] ?? 0);
        hit = operator === "newer_than" ? message.internalDate > since : message.internalDate <= since;
        break;
      }
      case "category":
        hit = message.labels.includes(CATEGORIES[value] ?? `CATEGORY_${value.toUpperCase()}`);
        break;
      case "has":
        // The fake's mail carries no attachments, and the agent's mailbox has no stars or user colours.
        hit = value === "userlabels" && message.labels.some((label) => label.startsWith("Label_"));
        break;
      case "after":
      case "before": {
        const at = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value.replace(/\//g, "-"));
        hit = operator === "after" ? message.internalDate > at : message.internalDate < at;
        break;
      }
      default:
        hit = `${email.subject} ${email.text ?? ""}`.toLowerCase().includes(value);
    }
    return negated ? !hit : hit;
  };
  return groups.every((group) => group.some(holds));
}

/**
 * Gmail's REST API as each app's mailbox sees it (`googleapis`, `rootUrl` from `GOOGLE_API_URL`),
 * Google's token endpoint for each app's OAuth client and refresh token, and the certificates its
 * push tokens are checked with. Every Gmail call needs an access token the token endpoint handed
 * out, answers as that token's mailbox (decision 0027), and is on record for the sessions whose
 * mail it touched, by the SDK's method name (`users.messages.get`).
 */
export function createGoogleApi(
  context: DriverContext,
  world: FakeGoogleWorld,
  certs: () => Promise<PushCertificates>,
): Hono {
  const { store } = world;
  const { clock } = context;
  /** The access tokens handed out: whose mailbox each is for, by its app's name, and when it expires. */
  const tokens = new Map<string, { app: string; expires: number }>();
  const unauthenticated = (operation: string) => operation.startsWith("oauth2.");
  /** The mailbox whose token made the call: each token answers as its own mailbox (decision 0027). */
  const meOf = (c: Context) => c.get(MAILBOX as never) as GoogleAppRecord;

  const { endpoint, finish } = restApi(context, {
    driver: "google",
    authorize(c, operation) {
      if (unauthenticated(operation)) return undefined;
      const token = bearerFrom(c.req.header("authorization"));
      const realm = 'Bearer realm="https://accounts.google.com/"';
      if (token === undefined) {
        return errorAnswer(
          new GmailApiError(
            401,
            "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
            "required",
            "UNAUTHENTICATED",
            { "www-authenticate": realm },
          ),
        );
      }
      const issued = [...tokens].find(([one]) => constantTimeEqual(one, token))?.[1];
      const me = issued === undefined ? undefined : store.apps.named(issued.app);
      if (issued === undefined || me === undefined || issued.expires < clock()) {
        return errorAnswer(
          new GmailApiError(
            401,
            "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
            "authError",
            "UNAUTHENTICATED",
            { "www-authenticate": `${realm}, error="invalid_token"` },
          ),
        );
      }
      const user = c.req.param("userId");
      if (user !== undefined && user !== "me" && user.toLowerCase() !== me.address) {
        return errorAnswer(
          new GmailApiError(403, `Delegation denied for ${me.address}`, "forbidden", "PERMISSION_DENIED"),
        );
      }
      c.set(MAILBOX as never, me as never);
      return undefined;
    },
    refusal: (error) => (error instanceof GmailApiError ? errorAnswer(error) : undefined),
    invalidJson: () =>
      errorAnswer(new GmailApiError(400, "Invalid JSON payload received.", "parseError", "INVALID_ARGUMENT")),
    notFound: () => errorAnswer(new GmailApiError(404, "Not Found", "notFound", "NOT_FOUND")),
  });

  // --- OAuth: the refresh-token grant, and the certificates push tokens are signed against --------

  // OAuth's token request is a form (RFC 6749, 4.1.3); Gmail's own endpoints take JSON only.
  const OAUTH_FORM = { form: true };
  endpoint(
    "post",
    "/token",
    "oauth2.token",
    (_c, body) => {
      if (body.grant_type !== "refresh_token") {
        return oauthRefusal(400, "unsupported_grant_type", `Invalid grant_type: ${String(body.grant_type ?? "")}`);
      }
      // Each app has its own OAuth client, and its mailbox's refresh token is that client's.
      const same = (given: unknown, secret: string) => typeof given === "string" && constantTimeEqual(given, secret);
      const client = store.apps.all().find((app) => {
        const { clientId, clientSecret } = world.credentials(app);
        return same(body.client_id, clientId) && same(body.client_secret, clientSecret);
      });
      if (!client) return oauthRefusal(401, "invalid_client", "The OAuth client was not found.");
      if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
        return oauthRefusal(400, "invalid_request", "Missing required parameter: refresh_token");
      }
      if (!same(body.refresh_token, world.credentials(client).refreshToken)) {
        return oauthRefusal(400, "invalid_grant", "Token has been expired or revoked.");
      }
      const token = GOOGLE_SECRETS.accessToken.generate();
      tokens.set(token, { app: client.name, expires: clock() + TOKEN_LIFETIME_S * 1000 });
      return {
        body: { access_token: token, expires_in: TOKEN_LIFETIME_S, scope: SCOPE, token_type: "Bearer" },
        sessions: [],
        headers: { "cache-control": "no-cache, no-store, max-age=0, must-revalidate" },
      };
    },
    OAUTH_FORM,
  );

  const cached = { "cache-control": `public, max-age=${CERTS_MAX_AGE_S}, must-revalidate, no-transform` };
  endpoint("get", "/oauth2/v1/certs", "oauth2.certs", async () => ({
    body: (await certs()).pem,
    sessions: [],
    headers: cached,
  }));
  endpoint("get", "/oauth2/v3/certs", "oauth2.certs", async () => ({
    body: (await certs()).jwk,
    sessions: [],
    headers: cached,
  }));

  // --- The mailbox --------------------------------------------------------------------------------

  const base = "/gmail/v1/users/:userId";
  /** The caller's mailbox: its labels, watch and history. */
  const boxOf = (c: Context) => store.mailbox(meOf(c).name);
  /** A message of the caller's mailbox by its id, as Gmail looks one up: another mailbox's isn't found. */
  const messageAt = (c: Context, name = "id") => {
    const id = c.req.param(name) ?? "";
    if (!/^[0-9a-f]{16}$/.test(id)) throw invalid("Invalid id value");
    const message = store.messages.find(id);
    if (!message || message.mailbox !== meOf(c).name) throw notFound();
    return message;
  };
  const threadAt = (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f]{16}$/.test(id)) throw invalid("Invalid id value");
    const messages = store.messagesIn(id).filter((message) => message.mailbox === meOf(c).name);
    if (messages.length === 0) throw notFound();
    return { id, messages };
  };
  const formatOf = (c: Context): MessageFormat => {
    const format = c.req.query("format") ?? "full";
    if (!["full", "metadata", "minimal", "raw"].includes(format))
      throw invalid(`Invalid value at 'format' (${format})`);
    return format as MessageFormat;
  };
  const shown = (c: Context, message: GmailMessageRecord) =>
    googlePayloads.message(message, world.emailOf(message), formatOf(c), c.req.queries("metadataHeaders") ?? []);
  /** The mailbox's messages a list shows: newest first, without trash and spam unless asked. */
  const listed = (c: Context) => {
    const q = c.req.query("q") ?? "";
    const labelIds = c.req.queries("labelIds") ?? [];
    // A search or a label that names the trash or spam lists it, as `includeSpamTrash` does.
    const spamTrash =
      c.req.query("includeSpamTrash") === "true" ||
      /(^|\s)in:(trash|spam|anywhere)\b/i.test(q) ||
      labelIds.some((label) => label === "TRASH" || label === "SPAM");
    return store
      .messagesOf(meOf(c).name)
      .filter((message) => spamTrash || !message.labels.some((label) => label === "TRASH" || label === "SPAM"))
      .filter((message) => labelIds.every((label) => message.labels.includes(label)))
      .filter((message) => matches(world, message, q, clock()))
      .sort((a, b) => b.internalDate - a.internalDate);
  };
  const labelsOf = (body: Record<string, unknown>, name: string) =>
    Array.isArray(body[name])
      ? (body[name] as unknown[]).filter((label): label is string => typeof label === "string")
      : [];

  endpoint("get", `${base}/profile`, "users.getProfile", (c) => {
    const mine = store.messagesOf(meOf(c).name);
    return answer({
      emailAddress: meOf(c).address,
      messagesTotal: mine.length,
      threadsTotal: new Set(mine.map((message) => message.threadId)).size,
      historyId: boxOf(c).historyId,
    });
  });

  endpoint("post", `${base}/watch`, "users.watch", (c, body) => {
    if (typeof body.topicName !== "string")
      throw invalid("Invalid topicName does not match projects/SOME-PROJECT/topics/SOME-TOPIC");
    const behavior = String(body.labelFilterBehavior ?? body.labelFilterAction ?? "include").toLowerCase();
    return answer(
      world.watch(meOf(c), {
        topicName: body.topicName,
        labelIds: labelsOf(body, "labelIds"),
        behavior: behavior === "exclude" ? "exclude" : "include",
      }),
    );
  });

  endpoint("post", `${base}/stop`, "users.stop", (c) => {
    world.stop(meOf(c));
    return { body: undefined, sessions: [], status: 204 };
  });

  endpoint("get", `${base}/history`, "users.history.list", (c) => {
    const start = c.req.query("startHistoryId");
    if (start === undefined || !/^\d+$/.test(start)) throw invalid("Invalid startHistoryId");
    const box = boxOf(c);
    if (BigInt(start) < BigInt(box.historyStart)) throw notFound();
    const types = c.req.queries("historyTypes") ?? [];
    const label = c.req.query("labelId");
    const entries = store.history
      .values()
      .filter((entry) => entry.mailbox === meOf(c).name)
      .filter((entry) => BigInt(entry.id) > BigInt(start))
      .filter((entry) => types.length === 0 || types.includes(entry.kind))
      .filter((entry) => label === undefined || entry.labelsAfter.includes(label) || entry.labels.includes(label))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const { items, next } = page(c, entries);
    const messages = items.flatMap((entry) => store.messages.find(entry.message) ?? []);
    return answer(
      {
        ...(items.length > 0 ? { history: items.map(googlePayloads.history) } : {}),
        ...(next ? { nextPageToken: next } : {}),
        historyId: box.historyId,
      },
      messages,
      world,
    );
  });

  endpoint("get", `${base}/messages`, "users.messages.list", (c) => {
    const all = listed(c);
    const { items, next } = page(c, all);
    return answer(
      {
        ...(items.length > 0 ? { messages: items.map(googlePayloads.ref) } : {}),
        ...(next ? { nextPageToken: next } : {}),
        resultSizeEstimate: all.length,
      },
      items,
      world,
    );
  });

  endpoint("post", `${base}/messages/send`, "users.messages.send", async (c, body) => {
    if (typeof body.raw !== "string" || body.raw === "")
      throw invalid("'raw' RFC822 payload message string or uploading message via /upload/* URL required");
    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    const message = await world.appSends(Buffer.from(body.raw, "base64url").toString("utf8"), threadId, meOf(c));
    return answer({ id: message.id, threadId: message.threadId, labelIds: [...message.labels] }, [message], world);
  });

  endpoint("get", `${base}/messages/:id`, "users.messages.get", (c) => {
    const message = messageAt(c);
    return answer(shown(c, message), [message], world);
  });

  endpoint("post", `${base}/messages/:id/modify`, "users.messages.modify", (c, body) => {
    const message = world.modify(messageAt(c), labelsOf(body, "addLabelIds"), labelsOf(body, "removeLabelIds"));
    return answer(googlePayloads.message(message, world.emailOf(message), "minimal"), [message], world);
  });

  endpoint("post", `${base}/messages/:id/trash`, "users.messages.trash", (c) => {
    const message = world.modify(messageAt(c), ["TRASH"], []);
    return answer(googlePayloads.message(message, world.emailOf(message), "minimal"), [message], world);
  });

  endpoint("post", `${base}/messages/:id/untrash`, "users.messages.untrash", (c) => {
    const message = world.modify(messageAt(c), [], ["TRASH"]);
    return answer(googlePayloads.message(message, world.emailOf(message), "minimal"), [message], world);
  });

  // --- Threads ------------------------------------------------------------------------------------

  /** A thread's history id: the last change to any of its messages, as Gmail's `Thread.historyId` is. */
  const threadHistoryId = (threadId: string) =>
    store
      .messagesIn(threadId)
      .map((message) => message.historyId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0];

  /** A thread as Gmail shows it: its history id, its messages oldest first. */
  const threadBody = (c: Context, thread: { id: string; messages: GmailMessageRecord[] }) => ({
    id: thread.id,
    historyId: threadHistoryId(thread.id),
    messages: thread.messages.map((message) => shown(c, message)),
  });

  endpoint("get", `${base}/threads`, "users.threads.list", (c) => {
    const newest = new Map<string, GmailMessageRecord>();
    for (const message of listed(c)) if (!newest.has(message.threadId)) newest.set(message.threadId, message);
    const all = [...newest.values()];
    const { items, next } = page(c, all);
    return answer(
      {
        ...(items.length > 0
          ? {
              threads: items.map((message) => ({
                id: message.threadId,
                snippet: googlePayloads.message(message, world.emailOf(message), "minimal").snippet,
                historyId: threadHistoryId(message.threadId),
              })),
            }
          : {}),
        ...(next ? { nextPageToken: next } : {}),
        resultSizeEstimate: all.length,
      },
      items,
      world,
    );
  });

  endpoint("get", `${base}/threads/:id`, "users.threads.get", (c) => {
    const thread = threadAt(c);
    return answer(threadBody(c, thread), thread.messages, world);
  });

  endpoint("post", `${base}/threads/:id/modify`, "users.threads.modify", (c, body) => {
    const thread = threadAt(c);
    for (const message of thread.messages) {
      world.modify(message, labelsOf(body, "addLabelIds"), labelsOf(body, "removeLabelIds"));
    }
    return answer(threadBody(c, { ...thread, messages: store.messagesIn(thread.id) }), thread.messages, world);
  });

  endpoint("post", `${base}/threads/:id/trash`, "users.threads.trash", (c) => {
    const thread = threadAt(c);
    for (const message of thread.messages) world.modify(message, ["TRASH"], []);
    return answer(threadBody(c, thread), thread.messages, world);
  });

  // --- Labels -------------------------------------------------------------------------------------

  endpoint("get", `${base}/labels`, "users.labels.list", (c) =>
    answer({ labels: [...boxOf(c).labels.values()].map((label) => googlePayloads.label(label)) }),
  );

  endpoint("get", `${base}/labels/:id`, "users.labels.get", (c) => {
    const label = boxOf(c).labels.get(c.req.param("id") ?? "");
    if (!label) throw notFound();
    const messages = store.messagesOf(meOf(c).name).filter((message) => message.labels.includes(label.id));
    return answer(
      googlePayloads.label(label, { messages, threads: new Set(messages.map((message) => message.threadId)) }),
    );
  });

  /** A label's name as a request gives it: not empty, and no other label's (`except`: the one being changed). */
  const labelName = (c: Context, given: unknown, except?: string) => {
    const name = typeof given === "string" ? given.trim() : "";
    if (name === "") throw invalid("Invalid label name");
    const taken = [...boxOf(c).labels.values()].some(
      (label) => label.id !== except && label.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new GmailApiError(409, "Label name exists or conflicts", "duplicate", "ALREADY_EXISTS");
    return name;
  };
  /** A label's visibility as a request asks for it, or as it was. */
  const visibilityOf = (body: Record<string, unknown>, was?: GmailLabelRecord) => ({
    messageListVisibility:
      body.messageListVisibility === "hide" || body.messageListVisibility === "show"
        ? body.messageListVisibility
        : (was?.messageListVisibility ?? ("show" as const)),
    labelListVisibility:
      body.labelListVisibility === "labelShow" ||
      body.labelListVisibility === "labelHide" ||
      body.labelListVisibility === "labelShowIfUnread"
        ? body.labelListVisibility
        : (was?.labelListVisibility ?? ("labelShow" as const)),
  });
  /** A label the app made: Gmail's own can't be changed or deleted. */
  const userLabelAt = (c: Context, refusal: string) => {
    const label = boxOf(c).labels.get(c.req.param("id") ?? "");
    if (!label) throw notFound();
    if (label.type === "system") throw invalid(refusal);
    return label;
  };

  endpoint("post", `${base}/labels`, "users.labels.create", (c, body) => {
    const label: GmailLabelRecord = {
      id: boxOf(c).nextLabelId(),
      name: labelName(c, body.name),
      type: "user",
      ...visibilityOf(body),
    };
    boxOf(c).labels.set(label.id, label);
    return answer(googlePayloads.label(label));
  });

  // `update` replaces the label, so it needs a name; `patch` changes what it is given.
  for (const [method, operation] of [
    ["put", "users.labels.update"],
    ["patch", "users.labels.patch"],
  ] as const) {
    endpoint(method, `${base}/labels/:id`, operation, (c, body) => {
      const was = userLabelAt(c, "Invalid update request");
      const name = method === "patch" && body.name === undefined ? was.name : labelName(c, body.name, was.id);
      const label: GmailLabelRecord = { ...was, name, ...visibilityOf(body, was) };
      boxOf(c).labels.set(label.id, label);
      return answer(googlePayloads.label(label));
    });
  }

  endpoint("delete", `${base}/labels/:id`, "users.labels.delete", (c) => {
    const label = userLabelAt(c, "Invalid delete request");
    // Gmail takes it off every message that has it, and answers nothing.
    const had = store.messagesOf(meOf(c).name).filter((message) => message.labels.includes(label.id));
    for (const message of had) world.modify(message, [], [label.id]);
    boxOf(c).labels.delete(label.id);
    return { body: undefined, sessions: had.map((message) => store.messages.owner(message.id)), status: 204 };
  });

  return finish();
}
