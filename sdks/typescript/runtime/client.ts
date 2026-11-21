import { launch, type LaunchOptions } from "./launcher.ts";
import { ChannelstackError, type ErrorClasses, segment, Transport } from "./transport.ts";
import type { QuietState } from "./wait.ts";

/** What a handle needs to call the server: the transport, and the session it lives in. */
export interface HandleContext {
  readonly transport: Transport;
  readonly session: string | undefined;
}

/** The session a handle lives in. Only the root client has none. */
export function sessionOf(context: HandleContext): string {
  if (context.session === undefined) throw new Error("This handle doesn't belong to a session");
  return context.session;
}

/**
 * Every handle that lives in a session answers this: is the agent quiet there? Matchers use it for
 * negative and exact-count checks, whatever handle they are given.
 */
export const QUIET: unique symbol = Symbol.for("channelstack.quiet");

/** Anything a matcher can ask about quiet: any generated handle in a session. */
export interface InSession {
  [QUIET](): Promise<QuietState>;
}

/** Give a value its text form: `String(value)` and `value.toString()` return `text`, and the value keeps its fields. */
export function printsAs<T extends object>(value: T, text: string): T & { toString(): string } {
  return Object.defineProperty(value, "toString", { value: () => text, enumerable: false }) as T & {
    toString(): string;
  };
}

/** Ask the server whether the agent is quiet in the session a handle lives in. */
export async function quietOf(context: HandleContext): Promise<QuietState> {
  return (await context.transport.request("GET", `/sessions/${segment(sessionOf(context))}/quiet`)) as QuietState;
}

/**
 * Run a handle's disposer. Disposing only cleans up and never fails a test: when the handle is
 * already gone on the server (closed earlier, or dropped by a reset), there is nothing left to do.
 * An explicit call to the same method still reports that.
 */
export async function disposeQuietly(dispose: () => Promise<void>): Promise<void> {
  try {
    await dispose();
  } catch (error) {
    if (!(error instanceof ChannelstackError && error.status === 404)) throw error;
  }
}

/** Base of the generated root client: closing it stops the server if this client started it. */
export abstract class ClientBase implements AsyncDisposable {
  readonly #stop: () => Promise<void>;

  constructor(stop: () => Promise<void>) {
    this.#stop = stop;
  }

  async close(): Promise<void> {
    await this.#stop();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** What the generated SDK knows about the protocol it was generated from. */
export interface Protocol {
  basePath: string;
  errors: ErrorClasses;
  /** The server version the SDK was generated for. */
  version: string;
}

/** Find or start the server, check that it speaks this SDK's major version, and build the root client. */
export async function connectWith<T>(
  create: (transport: Transport, stop: () => Promise<void>) => T,
  protocol: Protocol,
  options: LaunchOptions,
): Promise<T> {
  const server = await launch(options);
  const transport = new Transport({
    url: server.url,
    token: server.token,
    basePath: protocol.basePath,
    errors: protocol.errors,
  });
  try {
    const { version } = (await transport.request("GET", "/status")) as { version: string };
    if (version.split(".")[0] !== protocol.version.split(".")[0]) {
      throw new Error(
        `The channelstack server is version ${version}, but this SDK was generated for ${protocol.version}`,
      );
    }
  } catch (error) {
    await server.stop();
    throw error;
  }
  return create(transport, server.stop);
}
