import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { writePrivateFile } from "../home/index.ts";

/**
 * The recorder (implementation plan 9.2): in proxy mode with `--record <dir>`, every exchange the
 * agent has with a routed host, and every webhook a fake delivers, written as its shape. A shape is
 * the structure (keys and types) and nothing else, except the values that name a kind of thing
 * (`ok`, `error`, `type`): no token, email, name or text the platform answered is ever written.
 * The shape differ compares the fake's shapes with the platform's, operation by operation.
 */

/** Values kept in a shape: codes and kinds, never content. */
const KINDS = new Set(["ok", "error", "type", "subtype", "kind", "object", "status", "state", "action", "event"]);

export type Shape = string | Shape[] | { [key: string]: Shape };

/** A value's shape: `"string"`, `"number"`, …, a code kept as `"=ok"`, an object's keys, a list's items merged. */
export function shapeOf(value: unknown, key?: string): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const items = value.map((item) => shapeOf(item));
    return items.length === 0 ? [] : [items.reduce(mergeShapes)];
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shapeOf(item, name)]));
  }
  if (typeof value === "string" && key !== undefined && KINDS.has(key) && value.length <= 64) return `=${value}`;
  if (typeof value === "boolean" && key === "ok") return `=${value}`;
  return typeof value;
}

/** Two shapes as one: an object has every key either has, and a key with two types has both (`string|null`). */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (Array.isArray(a) && Array.isArray(b)) {
    const items = [...a, ...b];
    return items.length === 0 ? [] : [items.reduce(mergeShapes)];
  }
  const object = (shape: Shape): shape is { [key: string]: Shape } =>
    typeof shape === "object" && !Array.isArray(shape);
  if (object(a) && object(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return Object.fromEntries(
      keys.map((key) => {
        const left = a[key];
        const right = b[key];
        return [key, left === undefined ? (right as Shape) : right === undefined ? left : mergeShapes(left, right)];
      }),
    );
  }
  if (typeof a === "string" && typeof b === "string")
    return [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  return JSON.stringify(a) === JSON.stringify(b) ? a : `${JSON.stringify(a)}|${JSON.stringify(b)}`;
}

/**
 * The operation an exchange is: a path with its ids taken out (`GET /repos/{owner}/{repo}/issues/{n}`),
 * or for GraphQL the operation's name (`POST /graphql IssueCreate`).
 */
export function operationOf(method: string, path: string, body: string): string {
  const segments = path.split("/").map((segment, at, all) => {
    if (/^\d+$/.test(segment)) return "{n}";
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(segment)) return "{id}";
    // An owner and a name after `repos`, an org or a person's login after `orgs` and `users`.
    if (all[at - 1] === "repos" && segment !== "") return "{owner}";
    if (all[at - 2] === "repos" && all[at - 1] !== "") return "{repo}";
    if ((all[at - 1] === "orgs" || all[at - 1] === "users") && segment !== "")
      return `{${all[at - 1] === "orgs" ? "org" : "user"}}`;
    return segment;
  });
  const operation = `${method.toUpperCase()} ${segments.join("/")}`;
  if (!path.endsWith("/graphql")) return operation;
  try {
    const { operationName, query } = JSON.parse(body) as { operationName?: string; query?: string };
    const named = operationName ?? /^\s*(?:query|mutation)\s+(\w+)/.exec(query ?? "")?.[1];
    return named ? `${operation} ${named}` : operation;
  } catch {
    return operation;
  }
}

/** One line of a recording. */
export interface RecordedShape {
  /** An API exchange the agent had, or a webhook it was sent. */
  kind: "api" | "webhook";
  channel: string;
  /** `POST /api/chat.postMessage`, or a webhook's event type. */
  operation: string;
  /** An API exchange's status. */
  status?: number;
  shape: Shape;
}

export interface Recorder {
  /** Send a request (to the fake, or to the platform) and record the exchange's shape. */
  exchange(channel: string, request: Request, send: (request: Request) => Promise<Response>): Promise<Response>;
  /** Record a webhook's shape: its type, and its JSON body. */
  webhook(channel: string, type: string, body: string): void;
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A recorder writing to `<dir>/shapes.jsonl`, private (0600). */
export function createRecorder(dir: string): Recorder {
  const file = join(dir, "shapes.jsonl");
  if (!existsSync(file)) writePrivateFile(file, "");
  const write = (line: RecordedShape) => appendFileSync(file, `${JSON.stringify(line)}\n`);
  return {
    async exchange(channel, request, send) {
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
      const response = await send(request);
      const text = await response.clone().text();
      const parsed = json(text);
      if (parsed !== undefined) {
        write({
          kind: "api",
          channel,
          operation: operationOf(request.method, new URL(request.url).pathname, body),
          status: response.status,
          shape: shapeOf(parsed),
        });
      }
      return response;
    },
    webhook(channel, type, body) {
      const parsed = json(body);
      if (parsed === undefined) return;
      // By type and action: `issues opened` and `issues closed` are shaped differently.
      const action = (parsed as { action?: unknown } | null)?.action;
      const operation = typeof action === "string" && action.length <= 64 ? `${type} ${action}` : type;
      write({ kind: "webhook", channel, operation, shape: shapeOf(parsed) });
    },
  };
}

/** Hop-by-hop headers a proxy doesn't pass on. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
  "te",
  "trailer",
]);

/**
 * Pass a request the agent sent to a routed host on to the platform itself: a live driver's agent
 * in proxy mode talks to the real API, through channelstack only so its exchanges can be recorded.
 */
export async function forward(
  request: Request,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  const answer = await fetchImpl(`https://${url.hostname}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
    redirect: "manual",
  });
  // The body as it came, without the encoding headers fetch already undid.
  const out = new Headers(answer.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(await answer.arrayBuffer(), {
    status: answer.status,
    statusText: answer.statusText,
    headers: out,
  });
}
