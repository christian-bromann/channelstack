/**
 * What the Twilio agents share, written once against the `twilio` SDK: the client, pointed at
 * `TWILIO_API_URL` when it is set, and the scripted answers, so tests can rely on what they say.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import twilio from "twilio";

/**
 * The `twilio` client. The SDK has no base-URL setting, so a custom `httpClient` (as Twilio's docs
 * show for a proxy) sends `https://api.twilio.com` to `TWILIO_API_URL`: the fake in tests. Unset,
 * it talks to Twilio itself.
 */
export function twilioClient(accountSid: string, authToken: string): twilio.Twilio {
  const base = process.env.TWILIO_API_URL;
  if (!base) return twilio(accountSid, authToken);
  class ApiUrl extends twilio.RequestClient {
    override request<TData>(options: Parameters<twilio.RequestClient["request"]>[0] & { data?: TData }) {
      return super.request<TData>({
        ...options,
        uri: options.uri.replace(/^https:\/\/api\.twilio\.com/, base as string),
      });
    }
  }
  return twilio(accountSid, authToken, { httpClient: new ApiUrl() });
}

/** What the agent texts back: short answers, and a long one that takes several segments. */
export function scriptedText(body: string): string {
  if (/invoice/i.test(body)) return "Your invoice is on your account page.";
  if (/tell me everything/i.test(body)) {
    return [
      "Your order left our warehouse this morning and is with the carrier now.",
      "It should arrive on Friday between 9am and 5pm; someone needs to sign for it.",
      "If nobody is home, the carrier leaves a note and tries again the next working day.",
      "Reply with any question and we'll get back to you.",
    ].join(" ");
  }
  if (/order/i.test(body)) return "Your order shipped today and arrives on Friday.";
  return `Thanks for your text. You wrote: ${body.trim()}`;
}

/**
 * A keyword Twilio answers itself with its default opt-out handling (`STOP`, `START`, `HELP` and
 * their synonyms), which an agent leaves alone: after `STOP` it may not text the person at all.
 */
export const twilioKeyword = (body: string): boolean =>
  /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|revoke|start|yes|unstop|help|info)$/i.test(body.trim());

/** A form body's parameters, as Twilio posts them. */
export const formParams = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));

/** A small HTTP server: each path's handler gets the request's URL (as Twilio signed it) and its body. */
export function listen(
  port: number,
  routes: Record<
    string,
    (url: string, request: IncomingMessage, body: string) => { status: number; body?: string; type?: string }
  >,
): void {
  createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const route = routes[path];
    const answer = route ? route(`http://${request.headers.host}${request.url}`, request, body) : { status: 404 };
    response.writeHead(answer.status, answer.type ? { "content-type": answer.type } : {});
    response.end(answer.body ?? "");
  }).listen(port, "127.0.0.1");
}
