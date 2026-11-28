/**
 * Media in answers, against the official `openai` SDK in process (exit check 14.3): the Images
 * API, speech, transcriptions and translations in each format a request may ask for, Chat
 * Completions' audio output, the placeholders as valid PNG and WAV files, and a placeholder in a
 * format the fake can't make as a script problem. Every answer is held to OpenAI's description.
 */
import { crc32, inflateSync } from "node:zlib";

import { APIError, toFile } from "openai";
import { describe, expect, test } from "vitest";

import { useOpenAIWorkspace } from "../../../test/openai-workspace.ts";
import { placeholderPng, placeholderWav } from "./media.ts";

const setup = useOpenAIWorkspace();

/** Bytes a test hands over, as the SDKs send a `MediaSource`. */
const content = (bytes: Uint8Array | string, name?: string) => ({
  content: Buffer.from(bytes).toString("base64"),
  ...(name === undefined ? {} : { name }),
});

/** Files of the formats the fake has no placeholder for: only their first bytes matter to it. */
const FILES = {
  mp3: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]),
  opus: new Uint8Array([...Buffer.from("OggS"), 0, 2, 0, 0]),
  aac: new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]),
  flac: new Uint8Array([...Buffer.from("fLaC"), 0, 0, 0, 0x22]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...Buffer.from("JFIF")]),
} as const;

/** A PNG as a decoder reads it: its chunks with their CRCs, its size, and pixel data that inflates to that size. */
function decodePng(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString("ascii");
    const body = buffer.subarray(at + 8, at + 8 + length);
    expect(buffer.readUInt32BE(at + 8 + length)).toBe(crc32(buffer.subarray(at + 4, at + 8 + length)));
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  // Greyscale, 8 bits: a filter byte and a byte per pixel, each row.
  expect(inflateSync(Buffer.concat(data)).length).toBe((width + 1) * height);
  return { width, height };
}

/** A WAV as a decoder reads it: RIFF, a PCM format chunk, and data whose length the header says. */
function decodeWav(bytes: Uint8Array): { seconds: number } {
  const buffer = Buffer.from(bytes);
  expect(buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(buffer.readUInt32LE(4)).toBe(buffer.length - 8);
  expect(buffer.subarray(8, 16).toString("ascii")).toBe("WAVEfmt ");
  expect(buffer.readUInt16LE(20)).toBe(1);
  expect(buffer.subarray(36, 40).toString("ascii")).toBe("data");
  expect(buffer.readUInt32LE(40)).toBe(buffer.length - 44);
  // Bytes a second, from the header.
  return { seconds: (buffer.length - 44) / buffer.readUInt32LE(28) };
}

const PROMPT = "a bar chart of this week's deploys";
/** A small PNG, as a test has one on disk. */
const CHART = placeholderPng(4, 4);

describe("the Images API", () => {
  test("generations: a placeholder PNG in base64, of the size the turn gives", async () => {
    const { client, respond } = await setup(PROMPT);
    await respond({
      turns: [{ image: [{ placeholder: { width: 64, height: 32 } }], text: "A bar chart, five bars." }],
      when: { endpoint: "images.generations" },
    });

    const answer = await client.images.generate({ model: "gpt-image-1", prompt: PROMPT });

    expect(answer.data).toHaveLength(1);
    expect(decodePng(Buffer.from(answer.data?.[0]?.b64_json ?? "", "base64"))).toEqual({ width: 64, height: 32 });
    expect(answer.data?.[0]?.revised_prompt).toBe("A bar chart, five bars.");
    expect(answer.output_format).toBe("png");
  });

  test("one image per `n`, as URLs served without a key", async () => {
    const { client, respond, h } = await setup(PROMPT);
    await respond({ turns: [{ image: [content(Buffer.from(CHART), "chart.png")] }] });

    const answer = await client.images.generate({ model: "dall-e-3", prompt: PROMPT, n: 2, response_format: "url" });

    expect(answer.data).toHaveLength(2);
    const downloaded = await h.app.fetch(new Request(answer.data?.[0]?.url ?? ""));
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from(CHART));
  });

  test("a file in the format asked for: a JPEG for `output_format: jpeg`", async () => {
    const { client, respond } = await setup(PROMPT);
    await respond({ turns: [{ image: [content(FILES.jpeg, "chart.jpg")] }] });

    const answer = await client.images.generate({ model: "gpt-image-1", prompt: PROMPT, output_format: "jpeg" });

    expect(Buffer.from(answer.data?.[0]?.b64_json ?? "", "base64")).toEqual(Buffer.from(FILES.jpeg));
    expect(answer.output_format).toBe("jpeg");
  });

  test("a placeholder in a format the fake can't make is a script problem, not a wrong body", async () => {
    const { client, respond, control } = await setup(PROMPT);
    await respond({ turns: [{ image: [{ placeholder: {} }] }] });

    const error = await client.images
      .generate({ model: "gpt-image-1", prompt: PROMPT, output_format: "webp" })
      .catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(
      expect.stringMatching(/placeholder, but the request asked for webp/),
    );
  });

  test("edits: the uploaded image is part of the request, by its hash", async () => {
    const { client, respond, control } = await setup(PROMPT);
    await respond({
      turns: [{ image: [{ placeholder: { width: 8, height: 8 } }] }],
      when: { endpoint: "images.edits" },
    });
    const image = Buffer.from(CHART);

    await client.images.edit({ model: "gpt-image-1", prompt: PROMPT, image: await toFile(image, "chart.png") });

    const [call] = await control("GET", "/calls");
    expect(call.request.file).toEqual(
      expect.objectContaining({ type: "image", mediaType: "image/png", bytes: image.length, filename: "chart.png" }),
    );
    expect(call.request.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(call.request.prompt).toBe(PROMPT);
  });
});

describe("speech", () => {
  test.each([
    ["wav", { placeholder: { seconds: 0.5 } }, "audio/wav"],
    ["pcm", { placeholder: { seconds: 0.5 } }, "audio/pcm"],
    ["mp3", content(FILES.mp3), "audio/mpeg"],
    ["opus", content(FILES.opus), "audio/opus"],
    ["aac", content(FILES.aac), "audio/aac"],
    ["flac", content(FILES.flac), "audio/flac"],
  ] as const)("%s, in the format asked for", async (format, audio, mediaType) => {
    const text = "The deploy failed at the migration step.";
    const { client, respond } = await setup(text);
    await respond({ turns: [{ audio }], when: { endpoint: "audio.speech" } });

    const response = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: format,
    });

    expect(response.headers.get("content-type")).toBe(mediaType);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (format === "wav") expect(decodeWav(bytes).seconds).toBe(0.5);
    else if (format === "pcm") expect(bytes.length).toBe(24_000);
    else expect(Buffer.from(bytes)).toEqual(Buffer.from(FILES[format]));
  });

  test("streamed as `speech.audio.delta` events with `stream_format: sse`", async () => {
    const text = "Deploying web.";
    const { client, respond } = await setup(text);
    await respond({ turns: [{ audio: { placeholder: { seconds: 1 } } }] });

    const response = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: "wav",
      stream_format: "sse",
    });

    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; audio?: string });
    expect(events.at(-1)?.type).toBe("speech.audio.done");
    const audio = Buffer.concat(events.flatMap((event) => (event.audio ? [Buffer.from(event.audio, "base64")] : [])));
    expect(decodeWav(audio).seconds).toBe(1);
  });

  test("mp3 from a placeholder is a script problem", async () => {
    const text = "Deploying web.";
    const { client, respond, control } = await setup(text);
    await respond({ turns: [{ audio: { placeholder: {} } }] });

    const error = await client.audio.speech
      .create({ model: "gpt-4o-mini-tts", voice: "alloy", input: text })
      .catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/asked for mp3/));
  });
});

/** Two seconds of silence, as an agent uploads a voice note. */
const voiceNote = () => toFile(Buffer.from(placeholderWav(2)), "note.wav");

describe("transcriptions and translations", () => {
  const TRANSCRIPT = "The deploy fails at the migration step. Roll back.";
  // What Ana wrote with her voice note: the agent passes it as the transcription's prompt, which attributes the call.
  const NOTE = "what broke in the web deploy yesterday?";

  test.each(["json", "verbose_json", "diarized_json"] as const)("%s", async (format) => {
    const { client, respond } = await setup();
    await respond({ turns: [TRANSCRIPT], when: { endpoint: "audio.transcriptions" } });

    const answer = (await client.audio.transcriptions.create({
      model: format === "diarized_json" ? "gpt-4o-transcribe-diarize" : "whisper-1",
      file: await voiceNote(),
      prompt: NOTE,
      response_format: format,
    })) as { text: string; duration?: number; segments?: unknown[] };

    expect(answer.text).toBe(TRANSCRIPT);
    if (format !== "json") {
      expect(answer.duration).toBe(2);
      expect(answer.segments).toHaveLength(2);
    }
  });

  test.each([
    ["text", `${TRANSCRIPT}\n`],
    [
      "srt",
      "1\n00:00:00,000 --> 00:00:01,000\nThe deploy fails at the migration step.\n\n2\n00:00:01,000 --> 00:00:02,000\nRoll back.\n",
    ],
    [
      "vtt",
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nThe deploy fails at the migration step.\n\n00:00:01.000 --> 00:00:02.000\nRoll back.\n",
    ],
  ] as const)("%s, as plain text", async (format, expected) => {
    const { client, respond } = await setup();
    await respond({ turns: [TRANSCRIPT] });

    const answer = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: await voiceNote(),
      prompt: NOTE,
      response_format: format,
    });

    expect(answer).toBe(expected);
  });

  test("streamed as transcript deltas, then the whole text", async () => {
    const { client, respond } = await setup();
    await respond({ turns: [{ text: ["The deploy", " fails."] }] });

    const stream = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: await voiceNote(),
      prompt: NOTE,
      stream: true,
    });
    const events: { type: string; delta?: string; text?: string }[] = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.delta ?? event.text)).toEqual(["The deploy", " fails.", "The deploy fails."]);
  });

  test("whisper-1 doesn't stream, as OpenAI refuses it", async () => {
    const { client } = await setup();

    const error = await client.audio.transcriptions
      .create({ model: "whisper-1", file: await voiceNote(), prompt: NOTE, stream: true })
      .catch((caught: unknown) => caught);

    expect((error as APIError).status).toBe(400);
  });

  test("translations, in JSON and text", async () => {
    const { client, respond } = await setup();
    await respond({ turns: ["Roll back the deploy."], times: 2, when: { endpoint: "audio.translations" } });

    const json = await client.audio.translations.create({ model: "whisper-1", file: await voiceNote(), prompt: NOTE });
    const text = await client.audio.translations.create({
      model: "whisper-1",
      file: await voiceNote(),
      prompt: NOTE,
      response_format: "text",
    });

    expect(json.text).toBe("Roll back the deploy.");
    expect(text).toBe("Roll back the deploy.\n");
  });
});

describe("Chat Completions' audio output", () => {
  const ask = (content: string) => [{ role: "user" as const, content }];

  test("the audio, with the text as its transcript", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ text: "Two incidents.", audio: { placeholder: { seconds: 1 } } }] });

    const answer = await client.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages: ask(prompt),
    });

    const message = answer.choices[0]?.message;
    expect(message?.content).toBeNull();
    expect(message?.audio?.transcript).toBe("Two incidents.");
    expect(message?.audio?.id).toMatch(/^audio_[0-9a-f]{32}$/);
    expect(decodeWav(Buffer.from(message?.audio?.data ?? "", "base64")).seconds).toBe(1);
  });

  test("streamed: the transcript, then the audio, in `delta.audio`", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ text: "Two incidents.", audio: { placeholder: { seconds: 1 } } }] });

    const stream = await client.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "pcm16" },
      messages: ask(prompt),
      stream: true,
    });
    let transcript = "";
    let data = "";
    for await (const chunk of stream) {
      const audio = (chunk.choices[0]?.delta as { audio?: { transcript?: string; data?: string } } | undefined)?.audio;
      transcript += audio?.transcript ?? "";
      data += audio?.data ?? "";
    }

    expect(transcript).toBe("Two incidents.");
    expect(Buffer.from(data, "base64").length).toBe(48_000);
  });

  test("audio asked for without its settings is refused; audio nobody asked for is a script problem", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ text: "Hi.", audio: { placeholder: {} } }] });

    const refused = await client.chat.completions
      .create({ model: "gpt-4o-audio-preview", modalities: ["text", "audio"], messages: ask(prompt) })
      .catch((caught: unknown) => caught);
    const problem = await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught);

    expect((refused as APIError).code).toBe("missing_required_parameter");
    expect((problem as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/didn't ask for audio/));
  });
});
