import { type LaunchOptions, launch } from "./launcher.ts";
import { ChannelstackError, type ErrorClasses, Transport } from "./transport.ts";

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
