/**
 * The smallest HTTP server around a framework that speaks web-standard Request and Response
 * (the Chat SDK does): one handler for a path, 404 for everything else.
 */
import { createServer } from "node:http";

export function serve(port: number, path: string, handle: (request: Request, body: string) => Promise<Response>): void {
  createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method ?? "GET",
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === "POST" ? { body } : {}),
    });
    const response = incoming.url === path ? await handle(request, body) : new Response("not found", { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, "127.0.0.1");
}
