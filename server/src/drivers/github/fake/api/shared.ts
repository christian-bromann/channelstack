import type { Context } from "hono";

import type { GitHubIssueRecord, GitHubRepoRecord } from "../../world.ts";
import { GitHubRefusal } from "../kit.ts";
import type { FakeGitHubWorld } from "../world.ts";

export type Json = Record<string, unknown>;

/** What a handler is given: the request, the world, and the repository the path names (the App is installed on it). */
export interface Call {
  c: Context;
  world: FakeGitHubWorld;
  repo: GitHubRepoRecord;
  /** The JSON body, or `{}` when there is none. */
  body: Json;
  /** The App's bot: whoever an installation token acts as. */
  bot: number;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** Registers the routes of one area of the API. `permission` is what the App's installation needs for it. */
export type Register = (
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  permission: readonly [name: string, level: "read" | "write"],
  handler: Handler,
) => void;

export const notFound = () => new GitHubRefusal(404, "Not Found");

export const invalid = (resource: string, field: string, code = "missing_field") =>
  new GitHubRefusal(422, "Validation Failed", [{ resource, field, code }]);

/** A path parameter that is a number: an issue number, a comment id. */
export function numberParam(c: Context, name: string): number {
  const value = Number(c.req.param(name));
  if (!Number.isSafeInteger(value) || value < 1) throw notFound();
  return value;
}

export const text = (body: Json, name: string): string | undefined => {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
};

export const list = (body: Json, name: string): unknown[] | undefined => {
  const value = body[name];
  return Array.isArray(value) ? value : undefined;
};

/** One page of a list, as GitHub pages: `per_page` (30, at most 100) and `page`, with a `Link` header when there is more. */
export function page<T>(c: Context, items: readonly T[]): T[] {
  const perPage = Math.min(Math.max(Number(c.req.query("per_page") ?? 30) || 30, 1), 100);
  const current = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
  const last = Math.max(Math.ceil(items.length / perPage), 1);
  const url = new URL(c.req.url);
  const link = (target: number, rel: string) => {
    url.searchParams.set("page", String(target));
    url.searchParams.set("per_page", String(perPage));
    return `<${url.toString()}>; rel="${rel}"`;
  };
  const links = [
    ...(current < last ? [link(current + 1, "next"), link(last, "last")] : []),
    ...(current > 1 ? [link(current - 1, "prev"), link(1, "first")] : []),
  ];
  if (links.length > 0) c.header("link", links.join(", "));
  return items.slice((current - 1) * perPage, current * perPage);
}

export const issueOf = ({ c, world, repo }: Call, name = "number"): GitHubIssueRecord =>
  world.kit.requireIssue(repo, numberParam(c, name));

export const pullOf = ({ c, world, repo }: Call, name = "number") => world.kit.requirePull(repo, numberParam(c, name));

/** People named in a request body by login. GitHub ignores a login it doesn't know. */
export function people({ world, repo }: Call, logins: readonly unknown[]): number[] {
  const session = world.kit.store.sessionOf(repo);
  return logins.flatMap((login) => {
    const user = typeof login === "string" ? world.kit.store.byLogin(session, login) : undefined;
    return user ? [user.id] : [];
  });
}
