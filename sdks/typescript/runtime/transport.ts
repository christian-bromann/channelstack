/** An error from the control API. `code` is the protocol's stable error code. */
export class ChannelstackError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Readonly<Record<string, unknown>>;

  constructor(code: string, status: number, message: string, data: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** Error code → the typed exception the generated SDK declares for it. */
export type ErrorClasses = Readonly<Record<string, typeof ChannelstackError>>;

export interface TransportOptions {
  /** The server's base URL, e.g. `https://channelstack.localhost`. */
  url: string;
  token: string;
  /** The control API's path prefix on the server. */
  basePath: string;
  errors: ErrorClasses;
}

export interface RequestOptions {
  body?: unknown;
  query?: Readonly<Record<string, string | undefined>>;
}

/** How long to keep retrying a connection that is refused, while the server starts. */
const CONNECT_RETRY_MS = 5000;
const CONNECT_RETRY_INTERVAL_MS = 100;

/** Node reports a refused connection as `cause.code === "ECONNREFUSED"`, Bun as `code === "ConnectionRefused"`. */
function isConnectionRefused(error: unknown): boolean {
  const codes = [(error as { code?: unknown }).code, (error as { cause?: { code?: unknown } }).cause?.code];
  return codes.includes("ECONNREFUSED") || codes.includes("ConnectionRefused");
}

/** One path segment, escaped. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** The HTTP client every generated method goes through: bearer token, retries while the server starts, typed errors. */
export class Transport {
  readonly #options: TransportOptions;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.#options.basePath}${path}`, this.#options.url);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const response = await this.#send(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not the control API talking: a proxy's error page, for example.
      throw new ChannelstackError("internal", response.status, `HTTP ${response.status}: the response is not JSON`);
    }
    if (response.ok) return payload;
    const {
      error = "internal",
      message = `HTTP ${response.status}`,
      data = {},
    } = (typeof payload === "object" && payload !== null ? payload : {}) as {
      error?: string;
      message?: string;
      data?: Record<string, unknown>;
    };
    const ErrorClass = this.#options.errors[error] ?? ChannelstackError;
    throw new ErrorClass(error, response.status, message, data);
  }

  async #send(url: URL, init: RequestInit): Promise<Response> {
    const deadline = Date.now() + CONNECT_RETRY_MS;
    for (;;) {
      try {
        return await fetch(url, init);
      } catch (error) {
        // Only a refused connection is retried: the server isn't listening yet, so nothing was sent.
        // Any other failure may have happened after the request went out, and a POST must not run twice.
        if (!isConnectionRefused(error) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_INTERVAL_MS));
      }
    }
  }
}
