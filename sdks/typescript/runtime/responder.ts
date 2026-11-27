/**
 * Answering model calls from the test (decision 0029): the server holds each call a responder
 * script matches, and this loop reads them (a long poll), runs the test's function and posts what
 * it returns. It runs until the script is undone or its session closes, which end its reads.
 */

/** What the loop needs of a responder's handle: its long-poll read, and the way to answer. */
export interface ResponderIo<Request, Turn> {
  held(options: { since?: string; waitMs?: number }): Promise<{ held: ReadonlyArray<{ id: string; request: Request }>; cursor: string }>;
  answer(id: string, options: { turn?: Turn; error?: string }): Promise<void>;
}

/** A function a test answers model calls with. */
export type Responder<Request, Turn> = (request: Request) => Turn | Promise<Turn>;

/** How long one read waits on the server for a held call: well inside any HTTP timeout. */
const LONG_POLL_MS = 20_000;

/** Start answering a responder script's calls in the background. */
export function respondWith<Request, Turn>(io: ResponderIo<Request, Turn>, respond: Responder<Request, Turn>): void {
  void (async () => {
    let since: string | undefined;
    for (;;) {
      let page: Awaited<ReturnType<ResponderIo<Request, Turn>["held"]>>;
      try {
        page = await io.held({ ...(since === undefined ? {} : { since }), waitMs: LONG_POLL_MS });
      } catch {
        // The script was undone, or its session closed: nothing more will be held for it.
        return;
      }
      since = page.cursor;
      for (const held of page.held) {
        // Each call is answered on its own, so a slow answer doesn't hold up the next call.
        void (async () => {
          let answer: { turn?: Turn; error?: string };
          try {
            answer = { turn: await respond(held.request) };
          } catch (error) {
            answer = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
          }
          try {
            await io.answer(held.id, answer);
          } catch {
            // The agent hung up, or the call was answered by its timeout: the server has recorded why.
          }
        })();
      }
    }
  })();
}
