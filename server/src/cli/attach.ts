import { CONTROL_PREFIX } from "../app.ts";
import { homeDir, readPrivateJsonFile } from "../core/home/index.ts";
import { serverFilePath } from "../serve.ts";

/** A problem to tell the person at the terminal, in one line. The CLI prints it and exits with 1. */
export class CliError extends Error {}

/** Where the attach commands find the running server, from flags, the environment or `server.json`. */
export interface AttachFlags {
  server?: string | undefined;
  "server-file"?: string | undefined;
}

/** A running server the CLI talks to through the control API. */
export interface Attached {
  readonly url: string;
  /** Call the control API. Throws a `CliError` with the server's message when it refuses. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** The long-lived session the CLI, the UI and MCP share. Opened on first use. */
  devSession(): Promise<string>;
}

/** One path segment, encoded. */
export const segment = (value: string): string => encodeURIComponent(value);

/**
 * Attach to the running server: `--server <url>` or `CHANNELSTACK_URL` (with `CHANNELSTACK_TOKEN`),
 * otherwise what the server wrote to `server.json`.
 */
export function attach(flags: AttachFlags): Attached {
  const explicit = flags.server ?? process.env.CHANNELSTACK_URL;
  const file = flags["server-file"] ?? process.env.CHANNELSTACK_SERVER_FILE ?? serverFilePath(homeDir());
  const found = explicit
    ? { url: explicit, token: process.env.CHANNELSTACK_TOKEN }
    : (readPrivateJsonFile(file) as { url?: string; token?: string } | undefined);
  if (!found?.url) throw new CliError("no running server found. Start one with `channelstack start`.");
  if (!found.token) throw new CliError(`CHANNELSTACK_TOKEN is needed to talk to ${found.url}.`);
  const { url, token } = found;

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${CONTROL_PREFIX}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw new CliError(`the server at ${url} isn't reachable. Start one with \`channelstack start\`.`);
    });
    const text = await response.text();
    const data = text === "" ? undefined : (JSON.parse(text) as unknown);
    if (!response.ok) {
      const problem = data as { message?: string; error?: string } | undefined;
      throw new CliError(problem?.message ?? problem?.error ?? `the server refused the request (${response.status}).`);
    }
    return data as T;
  };

  let dev: Promise<string> | undefined;
  return {
    url,
    request,
    devSession: () => {
      dev ??= request<{ sessionId: string }>("POST", "/sessions", { name: "dev" }).then(({ sessionId }) => sessionId);
      return dev;
    },
  };
}
