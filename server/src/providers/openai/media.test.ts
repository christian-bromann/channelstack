/**
 * Media in requests (exit check 14.2), against the official `openai` SDK in process: each kind
 * of part (a data URL, a `file_id`, a URL) on both endpoints, recorded with its media type, size
 * and SHA-256; Slack's `url_private` refused with `invalid_image_url`, as OpenAI refuses a URL it
 * can't download; a public URL on a fake host fetched; other URLs recorded and not fetched. And
 * `/v1/files`, whose ids the parts use.
 */
import { createHash } from "node:crypto";

import { APIError, toFile } from "openai";
import { describe, expect, test } from "vitest";

import { useOpenAIWorkspace } from "../../../test/openai-workspace.ts";
import { placeholderPng, placeholderWav } from "./media.ts";

const setup = useOpenAIWorkspace();

const PNG = Buffer.from(placeholderPng(6, 6));
const WAV = Buffer.from(placeholderWav(0.25));
const PDF = Buffer.from("%PDF-1.7\n%fake\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dataUrl = (type: string, bytes: Uint8Array) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

/** The parts of the newest user message of the session's only call. */
async function partsOf(control: (method: string, path: string) => Promise<any>) {
  const [call] = await control("GET", "/calls");
  return call.request.messages.findLast((message: { role: string }) => message.role === "user").parts;
}

describe("the parts of a request, by their hash", () => {
  test("Chat Completions: an image as a data URL, audio, and a file's data", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["It's a chart."] });

    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } },
            { type: "input_audio", input_audio: { data: WAV.toString("base64"), format: "wav" } },
            { type: "file", file: { file_data: dataUrl("application/pdf", PDF), filename: "report.pdf" } },
          ],
        },
      ],
    });

    expect(await partsOf(control)).toEqual([
      { type: "image", from: "data", mediaType: "image/png", bytes: PNG.length, sha256: hash(PNG) },
      { type: "audio", from: "data", mediaType: "audio/wav", bytes: WAV.length, sha256: hash(WAV) },
      {
        type: "file",
        from: "data",
        mediaType: "application/pdf",
        bytes: PDF.length,
        sha256: hash(PDF),
        filename: "report.pdf",
      },
    ]);
  });

  test("Responses: an image as a data URL, and files by their `file_id` from /v1/files", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["Read them."] });
    const report = await client.files.create({ file: await toFile(PDF, "report.pdf"), purpose: "user_data" });
    const chart = await client.files.create({ file: await toFile(PNG, "chart.png"), purpose: "vision" });

    await client.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl("image/png", PNG), detail: "auto" },
            { type: "input_file", file_id: report.id },
            { type: "input_image", file_id: chart.id, detail: "auto" },
          ],
        },
      ],
    });

    expect(await partsOf(control)).toEqual([
      { type: "image", from: "data", mediaType: "image/png", bytes: PNG.length, sha256: hash(PNG) },
      {
        type: "file",
        from: "file_id",
        fileId: report.id,
        mediaType: "application/pdf",
        bytes: PDF.length,
        sha256: hash(PDF),
        filename: "report.pdf",
      },
      {
        type: "image",
        from: "file_id",
        fileId: chart.id,
        mediaType: "image/png",
        bytes: PNG.length,
        sha256: hash(PNG),
        filename: "chart.png",
      },
    ]);
  });

  test("a file_id /v1/files doesn't have is refused", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["Read it."] });

    const error = await client.responses
      .create({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_file", file_id: "file-AAAAAAAAAAAAAAAAAAAAAA" },
            ],
          },
        ],
      })
      .catch((caught: unknown) => caught);

    expect((error as APIError).status).toBe(400);
  });
});

describe("more parts, and what OpenAI refuses", () => {
  test("Chat Completions: a file by its file_id; Responses: a file's data, and a file URL elsewhere", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["Read them."], times: 2 });
    const report = await client.files.create({ file: await toFile(PDF, "report.pdf"), purpose: "user_data" });

    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "file", file: { file_id: report.id } },
          ],
        },
      ],
    });
    await client.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_data: dataUrl("application/pdf", PDF), filename: "report.pdf" },
            { type: "input_file", file_url: "https://files.example/report.pdf" },
          ],
        },
      ],
    });

    const [chat, responses] = await control("GET", "/calls");
    const parts = (call: any) => call.request.messages.findLast((message: any) => message.role === "user").parts;
    expect(parts(chat)).toEqual([
      expect.objectContaining({ type: "file", from: "file_id", fileId: report.id, sha256: hash(PDF) }),
    ]);
    expect(parts(responses)).toEqual([
      {
        type: "file",
        from: "data",
        mediaType: "application/pdf",
        bytes: PDF.length,
        sha256: hash(PDF),
        filename: "report.pdf",
      },
      { type: "file", from: "url", url: "https://files.example/report.pdf" },
    ]);
  });

  test("an image that isn't one is refused with invalid_image_format; a broken data URL with a 400, not a 500", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["Hm."], times: 2 });
    const ask = (url: string) =>
      client.chat.completions
        .create({
          model: "gpt-5",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url } },
              ],
            },
          ],
        })
        .catch((caught: unknown) => caught);

    const text = await ask("data:text/plain,hello");
    const broken = await ask("data:image/png,%E0%A4%A");

    expect([(text as APIError).status, (text as APIError).code]).toEqual([400, "invalid_image_format"]);
    expect([(broken as APIError).status, (broken as APIError).code]).toEqual([400, "invalid_image_url"]);
  });
});

describe("URLs", () => {
  test("Slack's url_private, handed to the model, is refused as OpenAI refuses it: there's no bot token", async () => {
    const { client, respond, h, agent, ana, channel, post } = await setup();
    await respond({ turns: ["It's a chart."] });
    await post(`/users/${ana.id}/say`, {
      message: { text: "@my-agent what's wrong here?" },
      channel: channel.id,
      files: [{ path: "error.png", content: PNG.toString("base64") }],
    });
    await h.app.settled();
    const event = agent.received.map((delivery) => JSON.parse(delivery.body).event).find((e) => e.files);
    const { url_private } = event.files[0];

    const error = await client.chat.completions
      .create({
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what's wrong here?" },
              { type: "image_url", image_url: { url: url_private } },
            ],
          },
        ],
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(400);
    expect((error as APIError).code).toBe("invalid_image_url");
    expect((error as APIError).message).toBe(`400 Error while downloading ${url_private}.`);

    // The same on Responses, where the URL is an `input_image`'s.
    const responses = await client.responses
      .create({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "what's wrong here?" },
              { type: "input_image", image_url: url_private, detail: "auto" },
            ],
          },
        ],
      })
      .catch((caught: unknown) => caught);
    expect([(responses as APIError).status, (responses as APIError).code]).toEqual([400, "invalid_image_url"]);
  });

  test("a public URL on a fake host is fetched, and recorded by its hash", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({
      turns: [{ image: [{ content: PNG.toString("base64") }] }],
      when: { endpoint: "images.generations" },
    });
    await respond({ turns: ["A chart."], when: { endpoint: "responses" } });
    const generated = await client.images.generate({ model: "dall-e-3", prompt, response_format: "url" });
    const url = generated.data?.[0]?.url ?? "";

    await client.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: url, detail: "auto" },
          ],
        },
      ],
    });

    const calls = await control("GET", "/calls?endpoint=responses");
    expect(calls[0].request.messages[0].parts).toEqual([
      { type: "image", from: "url", url, mediaType: "image/png", bytes: PNG.length, sha256: hash(PNG) },
    ]);
  });

  test("a URL elsewhere is recorded as given, and not fetched", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["A cat."] });

    await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: "https://upload.example/cat.png" } },
          ],
        },
      ],
    });

    expect(await partsOf(control)).toEqual([{ type: "image", from: "url", url: "https://upload.example/cat.png" }]);
  });
});

describe("/v1/files", () => {
  test("upload, list, read back byte for byte, delete", async () => {
    const { client } = await setup();

    const file = await client.files.create({ file: await toFile(PDF, "report.pdf"), purpose: "user_data" });
    expect(file).toEqual(
      expect.objectContaining({ object: "file", filename: "report.pdf", bytes: PDF.length, purpose: "user_data" }),
    );
    expect(file.id).toMatch(/^file-[0-9A-Za-z]{22}$/);
    expect((await client.files.list()).data.map(({ id }) => id)).toContain(file.id);
    expect((await client.files.retrieve(file.id)).filename).toBe("report.pdf");
    expect(Buffer.from(await (await client.files.content(file.id)).arrayBuffer())).toEqual(PDF);

    expect(await client.files.delete(file.id)).toEqual({ id: file.id, object: "file", deleted: true });
    const gone = await client.files.retrieve(file.id).catch((caught: unknown) => caught);
    expect((gone as APIError).status).toBe(404);
  });

  test("a purpose OpenAI doesn't have is refused", async () => {
    const { client } = await setup();

    const error = await client.files
      .create({ file: await toFile(PDF, "report.pdf"), purpose: "whatever" as never })
      .catch((caught: unknown) => caught);

    expect((error as APIError).status).toBe(400);
  });
});
