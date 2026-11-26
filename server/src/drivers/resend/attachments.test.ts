import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { driverContext } from "../../../test/driver-context.ts";
import { resendResponseProblems, resendWebhookProblems } from "../../../test/schemas/resend.ts";
import { parseMime } from "../../core/email/mime.ts";
import { createResendFake } from "./fake/index.ts";
import { resendPayloads } from "./payloads.ts";

/**
 * Attachments and the raw message, as Resend keeps and links them (#64): what the agent attaches
 * to `POST /emails`, what a person's email to the team carries, and the links the fake serves for
 * both, every answer held to Resend's description.
 */
let agent: RecordingAgent | undefined;
afterEach(() => agent?.close());

const PDF = Buffer.from("%PDF-1.4 a refund form");

async function team() {
  agent = await recordingAgent();
  const h = harness({ resend: agent.url });
  const { sessionId } = (await h.call("POST", `/sessions`)).body;
  const ana = (await h.call("POST", `/sessions/${sessionId}/resend/users`, { name: "Ana" })).body;
  const key = h.secrets.get("resend", "apiKey");
  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.provider(method, `resend${path}`, body, key, headers);
  /** Call, and hold a successful answer to Resend's description. */
  const read = async (method: string, path: string, body?: unknown) => {
    const reply = await api(method, path, body);
    expect(reply.status, JSON.stringify(reply.body)).toBeLessThan(400);
    expect(resendResponseProblems(method, path.split("?")[0] ?? path, reply.status, reply.body)).toEqual([]);
    return reply.body;
  };
  /** Open a download link, without the API key, as the agent's HTTP client would. */
  const download = (url: string) => h.app.fetch(new Request(url));
  /** An email from the agent, cc'ing Ana so it is the test's. */
  const email = (extra: Record<string, unknown> = {}) => ({
    from: "my-agent <my-agent@acme.example>",
    to: "delivered@resend.dev",
    cc: [ana.address],
    subject: "Your refund",
    text: "The form is attached.",
    ...extra,
  });
  return { h, api, read, download, email, sessionId, ana };
}

describe("the agent's attachments are kept, and linked as Resend links them", () => {
  test("base64 and a list of bytes, a name and type given or not, inline by `content_id`", async () => {
    const { read, download, email } = await team();
    const { id } = await read(
      "POST",
      "/emails",
      email({
        html: '<p>The form is attached.</p><img src="cid:logo">',
        attachments: [
          { filename: "refund.pdf", content: PDF.toString("base64"), content_type: "application/pdf" },
          { content: [104, 105] },
          { filename: "logo.png", content: Buffer.from("png").toString("base64"), content_id: "logo" },
        ],
      }),
    );
    const list = await read("GET", `/emails/${id}/attachments`);
    expect(
      list.data.map(({ download_url: _url, expires_at: _at, id: _id, ...rest }: Record<string, unknown>) => rest),
    ).toEqual([
      { filename: "refund.pdf", content_type: "application/pdf", content_disposition: "attachment", size: PDF.length },
      {
        filename: "attachment-1",
        content_type: "application/octet-stream",
        content_disposition: "attachment",
        size: 2,
      },
      {
        filename: "logo.png",
        content_type: "application/octet-stream",
        content_disposition: "inline",
        content_id: "logo",
        size: 3,
      },
    ]);
    const one = await read("GET", `/emails/${id}/attachments/${list.data[0].id}`);
    expect(one).toMatchObject({ object: "attachment", filename: "refund.pdf" });

    const file = await download(one.download_url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF);
    expect(Buffer.from(await (await download(list.data[1].download_url)).arrayBuffer())).toEqual(Buffer.from("hi"));
  });

  test("a link works for an hour, and only as it was given", async () => {
    const { h, read, download, email } = await team();
    const { id } = await read(
      "POST",
      "/emails",
      email({
        attachments: [
          { filename: "a.txt", content: "aGk=" },
          { filename: "b.txt", content: "aG8=" },
        ],
      }),
    );
    const [attachment, other] = (await read("GET", `/emails/${id}/attachments`)).data;
    expect(Date.parse(attachment.expires_at) - Date.now()).toBeGreaterThan(3_590_000);
    // `expires_at` is the moment the link stops working: its `Expires`, in whole seconds.
    expect(Date.parse(attachment.expires_at)).toBe(
      Number(new URL(attachment.download_url).searchParams.get("Expires")) * 1000,
    );
    // A link's signature opens what it was made for, and nothing else: another file, another email, a raw message.
    const signed = new URL(attachment.download_url).search;
    const elsewhere = (path: string) => `${new URL(attachment.download_url).origin}/resend/_cdn/${path}${signed}`;
    expect(
      (await download(`${new URL(other.download_url).origin}${new URL(other.download_url).pathname}${signed}`)).status,
    ).toBe(403);
    expect((await download(elsewhere(`${id}/raw`))).status).toBe(403);
    const second = await read("POST", "/emails", email({ attachments: [{ filename: "a.txt", content: "aGk=" }] }));
    expect((await download(elsewhere(`${second.id}/${attachment.id}`))).status).toBe(403);
    const changed = new URL(attachment.download_url);
    changed.searchParams.set("Expires", String(Number(changed.searchParams.get("Expires")) + 3600));
    expect((await download(changed.toString())).status).toBe(403);
    expect((await download(attachment.download_url.replace(/Signature=[0-9a-f]+/, "Signature=00"))).status).toBe(403);
    expect((await download(attachment.download_url)).status).toBe(200);
    h.clock.advance(3_600_001);
    expect((await download(attachment.download_url)).status).toBe(403);
  });

  test("an attachment with neither `content` nor `path` is refused; a batch sends without attachments", async () => {
    const { api, read, email } = await team();
    const refused = await api("POST", "/emails", email({ attachments: [{ filename: "a.txt" }] }));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      name: "invalid_attachment",
      message: "Attachment must have either a `content` or `path`.",
    });
    const sent = await read("POST", "/emails/batch", [
      email({ attachments: [{ filename: "a.txt", content: "aGk=" }] }),
    ]);
    expect((await read("GET", `/emails/${sent.data[0].id}/attachments`)).data).toEqual([]);
  });

  test("a `path` is fetched when the email is sent; one that can't be is refused", async () => {
    const files = createServer((request, response) => {
      fetched.push(request.url ?? "");
      if (request.url === "/receipt.pdf") response.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
      else if (request.url === "/large.bin")
        response.writeHead(200, { "content-length": String(LARGE) }).end(Buffer.alloc(LARGE));
      else if (request.url === "/streamed.bin") {
        // No length: the fake stops reading once it is over the limit.
        response.writeHead(200);
        const chunk = Buffer.alloc(1024 * 1024);
        const write = (left: number) => (left === 0 ? response.end() : response.write(chunk, () => write(left - 1)));
        write(Math.ceil(LARGE / chunk.length));
      } else if (request.url === "/dropped.bin") {
        // The connection drops halfway through the file.
        response.writeHead(200, { "content-length": "1000" });
        response.write(Buffer.alloc(10), () => response.destroy());
      } else if (request.url === "/slow.pdf") {
        // The file starts, and the rest comes when the test says so.
        response.writeHead(200, { "content-length": String(PDF.length) });
        response.write(PDF.subarray(0, 4));
        release = () => response.end(PDF.subarray(4));
      } else response.writeHead(404).end();
    });
    let release = () => {};
    const fetched: string[] = [];
    // 31 MB is over 40 MB in base64, which is how Resend counts its limit.
    const LARGE = 31 * 1024 * 1024;
    await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
    try {
      const { h, api, read, download, email } = await team();
      const { id } = await read("POST", "/emails", email({ attachments: [{ path: `${origin}/receipt.pdf` }] }));
      const [attachment] = (await read("GET", `/emails/${id}/attachments`)).data;
      expect(attachment).toMatchObject({ filename: "attachment-0", size: PDF.length });
      expect(Buffer.from(await (await download(attachment.download_url)).arrayBuffer())).toEqual(PDF);
      for (const path of [
        `${origin}/missing.pdf`,
        `${origin}/dropped.bin`,
        "ftp://127.0.0.1/receipt.pdf",
        "not a url",
      ]) {
        const refused = await api("POST", "/emails", email({ attachments: [{ path }] }));
        expect(refused.status, path).toBe(422);
        expect(refused.body.name).toBe("invalid_attachment");
      }
      for (const path of [`${origin}/large.bin`, `${origin}/streamed.bin`]) {
        const refused = await api("POST", "/emails", email({ attachments: [{ path }] }));
        expect(refused.status, path).toBe(422);
        expect(refused.body.message).toBe("The email's attachments are over the 40 MB limit.");
      }

      // Files are fetched only for a send that happens: not again for a repeated idempotency key, nor for a refused send.
      fetched.length = 0;
      const once = email({ attachments: [{ path: `${origin}/receipt.pdf` }] });
      const first = await api("POST", "/emails", once, { "idempotency-key": "receipt" });
      const again = await api("POST", "/emails", once, { "idempotency-key": "receipt" });
      expect(again.body).toEqual(first.body);
      const unverified = await api("POST", "/emails", { ...once, from: "x@elsewhere.example" });
      expect(unverified.status).toBe(403);
      expect(fetched).toEqual(["/receipt.pdf"]);

      // While a send with a key is under way, the same key again is refused, as Resend refuses it: not sent twice.
      // A second on first: the calls above used up the rate limit of 10 a second.
      h.clock.advance(1_100);
      const slow = email({ attachments: [{ path: `${origin}/slow.pdf` }] });
      const pending = api("POST", "/emails", slow, { "idempotency-key": "slow" });
      await vi.waitFor(() => expect(fetched).toContain("/slow.pdf"));
      const meanwhile = await api("POST", "/emails", slow, { "idempotency-key": "slow" });
      expect(meanwhile.status).toBe(409);
      expect(meanwhile.body.name).toBe("concurrent_idempotent_requests");
      release();
      const sent = await pending;
      expect(sent.status).toBe(200);
      expect((await api("POST", "/emails", slow, { "idempotency-key": "slow" })).body).toEqual(sent.body);
    } finally {
      files.close();
    }
  });

  test("a person reads the attachments' names in the thread; the email's text is what was written", async () => {
    const { h, read, email, sessionId, ana } = await team();
    const { id } = await read(
      "POST",
      "/emails",
      email({
        html: '<p>The form is attached.</p><img src="cid:logo">',
        attachments: [
          { filename: "refund.pdf", content: "aGk=" },
          // Shown in the body by its `Content-ID`: not a file a person sees attached.
          { filename: "logo.png", content: "aGk=", content_id: "logo" },
        ],
      }),
    );
    const transcript = (await h.call("GET", `/sessions/${sessionId}/resend/threads/${id}/transcript`)).body;
    expect(transcript.text).toContain("The form is attached.\n(attached: refund.pdf)");
    expect(transcript.text).not.toContain("logo.png");
    const [received] = (await h.call("GET", `/sessions/${sessionId}/resend/users/${encodeURIComponent(ana.id)}/inbox`))
      .body;
    expect(received.text).toBe("The form is attached.");
  });

  test("an email's attachments are listed in pages, as Resend's description says", async () => {
    const { read, email } = await team();
    const files = ["a", "b", "c"].map((name) => ({ filename: `${name}.txt`, content: "aGk=" }));
    const { id } = await read("POST", "/emails", email({ attachments: files }));
    const first = await read("GET", `/emails/${id}/attachments?limit=2`);
    expect(first.data.map((file: { filename: string }) => file.filename)).toEqual(["a.txt", "b.txt"]);
    expect(first.has_more).toBe(true);
    const rest = await read("GET", `/emails/${id}/attachments?after=${first.data[1].id}`);
    expect(rest.data.map((file: { filename: string }) => file.filename)).toEqual(["c.txt"]);
    expect(rest.has_more).toBe(false);
  });
});

describe("a received email's attachments and raw message", () => {
  /** The fake alone, with a person who emails the team: its API reached as the agent reaches it. */
  async function received(attachments: Array<{ filename: string; content: Uint8Array; contentType: string }>) {
    const context = driverContext({ apiUrl: () => "http://127.0.0.1:4500/resend" });
    const fake = createResendFake(context);
    const ana = fake.world.createUser("ses_a", { name: "Ana Lima" });
    const app = { address: fake.store.app.address, name: fake.store.app.name };
    const email = await fake.world.personSends("ses_a", ana, {
      to: [app],
      cc: [],
      subject: "Refund",
      text: "Where is my refund? The receipt is attached.",
      html: undefined,
      attachments: attachments.map((file) => ({ ...file, contentId: undefined })),
    });
    const fetchApi = async (url: string, key: string | undefined = context.secret("apiKey")) => {
      const path = new URL(url, "http://127.0.0.1:4500/resend").pathname.replace(/^\/resend/, "");
      return fake.api.fetch(
        new Request(`http://127.0.0.1:4500${path}${new URL(url, "http://x").search}`, {
          headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
        }),
      );
    };
    /** Call, and hold the answer to Resend's description: a JSON body, untyped as the harness's are. */
    const read = async (path: string): Promise<any> => {
      const reply = await fetchApi(path);
      const body = await reply.json();
      expect(reply.status, JSON.stringify(body)).toBe(200);
      expect(resendResponseProblems("GET", path, reply.status, body)).toEqual([]);
      return body;
    };
    return { email, read, open: (url: string) => fetchApi(url, undefined) };
  }

  test("the raw message is the email as the team received it, its attachments in it", async () => {
    const { email, read, open } = await received([
      { filename: "receipt.pdf", content: PDF, contentType: "application/pdf" },
    ]);
    const body = await read(`/emails/receiving/${email.id}`);
    expect(body.raw).toEqual({ download_url: expect.stringContaining("/_cdn/"), expires_at: expect.any(String) });
    expect(body.attachments).toEqual([
      {
        id: email.attachments[0]?.id,
        filename: "receipt.pdf",
        content_type: "application/pdf",
        content_disposition: "attachment",
        size: PDF.length,
      },
    ]);
    expect(body.headers["content-type"]).toMatch(/^multipart\/mixed/);
    expect(body.headers.received).toContain("inbound-smtp");

    const raw = await (await open(body.raw.download_url)).text();
    expect(raw.split("\r\n")[0]).toMatch(/^Received: /);
    const parsed = await parseMime(raw);
    expect(parsed).toMatchObject({
      subject: "Refund",
      messageId: email.messageId,
      text: expect.stringContaining("Where is my refund?"),
    });
    expect(raw).toContain("filename=receipt.pdf");

    const list = await read(`/emails/receiving/${email.id}/attachments`);
    const one = await read(`/emails/receiving/${email.id}/attachments/${list.data[0].id}`);
    expect(Buffer.from(await (await open(one.download_url)).arrayBuffer())).toEqual(PDF);
    expect((await read("/emails/receiving?limit=10")).data[0]).not.toHaveProperty("raw");
  });

  test("`email.received` names the attachments, as Resend's description says", async () => {
    const { email } = await received([{ filename: "receipt.pdf", content: PDF, contentType: "application/pdf" }]);
    const event = resendPayloads.received(email, Date.now());
    expect(resendWebhookProblems("email.received", event)).toEqual([]);
    expect((event.data as { attachments: unknown[] }).attachments).toEqual([
      {
        id: email.attachments[0]?.id,
        filename: "receipt.pdf",
        content_type: "application/pdf",
        content_disposition: "attachment",
      },
    ]);
  });

  test("an email without attachments has a raw message of its text alone", async () => {
    const { email, read, open } = await received([]);
    const body = await read(`/emails/receiving/${email.id}`);
    expect(body.attachments).toEqual([]);
    expect(body.headers["content-type"]).toMatch(/^text\/plain/);
    expect((await open(body.raw.download_url)).status).toBe(200);
  });
});
