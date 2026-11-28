import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { invalidRequest, OpenAIError } from "./errors.ts";
import type { MediaSource } from "./turns.ts";

/** An image, file or audio part the agent sent: identified by its hash, so a test can compare it with what a person shared. */
export interface ModelPart {
  readonly type: "image" | "file" | "audio";
  readonly from: "data" | "file_id" | "url";
  readonly url?: string;
  readonly fileId?: string;
  readonly mediaType?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly filename?: string;
  /** What the request said, before its bytes are read: a data URL or base64, and `input_audio`'s format. */
  readonly pending?: { readonly data?: string; readonly format?: string };
}

/** Bytes and what they are. */
export interface Media {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly filename?: string;
}

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The media type of a format a request asks for: an image's `output_format`, audio's `response_format`. */
const FORMAT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
  pcm16: "audio/pcm",
  pdf: "application/pdf",
};

/** What bytes are, from their first bytes: the formats OpenAI serves and takes. */
function sniff(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map((char) => char.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (ascii(0, "OggS")) return "audio/opus";
  if (ascii(0, "ID3") || at(0, 0xff, 0xfb) || at(0, 0xff, 0xf3) || at(0, 0xff, 0xf2)) return "audio/mpeg";
  if (at(0, 0xff, 0xf1) || at(0, 0xff, 0xf9)) return "audio/aac";
  if (ascii(0, "%PDF")) return "application/pdf";
  return undefined;
}

const byExtension = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : FORMAT_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""];

/** `data:<type>;base64,<bytes>`, or bare base64 (`input_audio`'s `data`). */
function decodeData(data: string): { mediaType?: string; bytes: Uint8Array } | undefined {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(data);
  if (!match)
    return /^[A-Za-z0-9+/=\s]*$/.test(data) ? { bytes: new Uint8Array(Buffer.from(data, "base64")) } : undefined;
  const [, type, base64, rest = ""] = match;
  let text: string;
  try {
    text = base64 ? "" : decodeURIComponent(rest);
  } catch {
    // A percent sign that starts no escape: not a data URL OpenAI can read.
    return undefined;
  }
  const bytes = base64 ? Buffer.from(rest, "base64") : Buffer.from(text, "utf8");
  return { ...(type ? { mediaType: type } : {}), bytes: new Uint8Array(bytes) };
}

// --- Placeholders ------------------------------------------------------------------------------

/** A PNG of a size: grey, opaque, valid for every decoder. */
export function placeholderPng(width = 1024, height = 1024): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8 bits, greyscale, deflate, no filter method, no interlace
  // Each row: filter type 0, then one grey byte per pixel.
  const row = Buffer.alloc(width + 1, 0xc0);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/** OpenAI's PCM: 24 kHz, 16-bit, mono, little-endian. Silence of a length. */
const SAMPLE_RATE = 24_000;
const placeholderPcm = (seconds = 1): Uint8Array => new Uint8Array(Math.round(seconds * SAMPLE_RATE) * 2);

/** WAV silence of a length: the PCM above with a RIFF header. */
export function placeholderWav(seconds = 1): Uint8Array {
  const pcm = placeholderPcm(seconds);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

/** How long a WAV or PCM file plays, from its size and header; undefined for what can't be told without decoding. */
export function audioSeconds(media: Media): number | undefined {
  const { bytes } = media;
  if (media.mediaType === "audio/pcm") return bytes.length / (SAMPLE_RATE * 2);
  if (sniff(bytes) !== "audio/wav" || bytes.length < 44) return undefined;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.readUInt32LE(28);
  return rate === 0 ? undefined : (bytes.length - 44) / rate;
}

/**
 * Media a turn answers with, in the format the request asks for. A file must be that format;
 * a placeholder is made only as PNG, WAV or PCM. Anything else is a script problem: never a body
 * with the wrong media type.
 */
export function answerMedia(source: MediaSource, format: string, what: string): Media | { problem: string } {
  const mediaType = FORMAT_TYPES[format] ?? format;
  if ("placeholder" in source) {
    const { width, height, seconds } = source.placeholder;
    if (mediaType === "image/png") return { bytes: placeholderPng(width, height), mediaType };
    if (mediaType === "audio/wav") return { bytes: placeholderWav(seconds), mediaType };
    if (mediaType === "audio/pcm") return { bytes: placeholderPcm(seconds), mediaType };
    return {
      problem: `${what} is a placeholder, but the request asked for ${format}: the fake makes placeholders only as PNG, WAV or PCM, so give a ${format} file`,
    };
  }
  const bytes = new Uint8Array(Buffer.from(source.content, "base64"));
  const found = sniff(bytes) ?? byExtension(source.name);
  // Raw PCM has no header to tell it by: any bytes are PCM.
  if (mediaType !== "audio/pcm" && found !== mediaType) {
    return {
      problem: `${what} is ${found ?? "a file of unknown type"}${source.name === undefined ? "" : ` (${source.name})`}, but the request asked for ${format}`,
    };
  }
  return { bytes, mediaType, ...(source.name === undefined ? {} : { filename: source.name }) };
}

/** A turn's media as the request's kind needs it, when the format doesn't matter (code interpreter's files): as given, or a PNG. */
export function anyMedia(source: MediaSource): Media {
  if ("placeholder" in source)
    return { bytes: placeholderPng(source.placeholder.width, source.placeholder.height), mediaType: "image/png" };
  const bytes = new Uint8Array(Buffer.from(source.content, "base64"));
  return {
    bytes,
    mediaType: mediaTypeOf(bytes, undefined, source.name),
    ...(source.name === undefined ? {} : { filename: source.name }),
  };
}

// --- Files -------------------------------------------------------------------------------------

/** A file uploaded to `/v1/files`, or one a container holds. */
export interface StoredFile extends Media {
  readonly id: string;
  readonly filename: string;
  readonly purpose: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

/** A file in a code interpreter's container: what the code wrote, downloadable by its path. */
export interface ContainerFile extends Media {
  readonly id: string;
  readonly container: string;
  readonly path: string;
  readonly filename: string;
  readonly createdAt: number;
}

/** The most the fake keeps of each: past this, the oldest are forgotten. */
const LIMIT = 2000;

/** `/v1/files`, and the containers' files. They belong to the world, as the agent's key does, and go with a reset. */
export class MediaStore {
  readonly files = new Map<string, StoredFile>();
  readonly containers = new Map<string, Map<string, ContainerFile>>();
  /** What the Images API answered with as a URL (`response_format: "url"`): served without a key, as OpenAI's are. */
  readonly generated = new Map<string, Media>();

  /** A file in `/v1/files` by its id, or by its name: what a citation or a file search names. */
  file(idOrName: string): StoredFile | undefined {
    return this.files.get(idOrName) ?? [...this.files.values()].find((file) => file.filename === idOrName);
  }

  keepFile(file: StoredFile): StoredFile {
    this.files.set(file.id, file);
    if (this.files.size > LIMIT) this.files.delete(this.files.keys().next().value as string);
    return file;
  }

  keepContainerFile(file: ContainerFile): ContainerFile {
    const files = this.containers.get(file.container) ?? new Map<string, ContainerFile>();
    files.set(file.id, file);
    this.containers.set(file.container, files);
    if (this.containers.size > LIMIT) this.containers.delete(this.containers.keys().next().value as string);
    return file;
  }

  keepGenerated(name: string, media: Media): void {
    this.generated.set(name, media);
    if (this.generated.size > LIMIT) this.generated.delete(this.generated.keys().next().value as string);
  }

  clear(): void {
    this.files.clear();
    this.containers.clear();
    this.generated.clear();
  }
}

/** The wire form of a stored file, as `/v1/files` answers. */
export const fileWire = (file: StoredFile) => ({
  id: file.id,
  object: "file",
  bytes: file.bytes.length,
  created_at: file.createdAt,
  ...(file.expiresAt === undefined ? {} : { expires_at: file.expiresAt }),
  filename: file.filename,
  purpose: file.purpose,
  status: "processed",
});

export const containerFileWire = (file: ContainerFile) => ({
  id: file.id,
  object: "container.file",
  container_id: file.container,
  created_at: file.createdAt,
  bytes: file.bytes.length,
  path: file.path,
  source: "assistant",
});

// --- Reading a request's parts -----------------------------------------------------------------

/** Fetch a URL the way an outside client would, without credentials: undefined when it isn't on a fake's address. */
export type FetchFake = (url: string) => Promise<Response> | undefined;

/**
 * A part with its bytes read: a data URL decoded, a `file_id` looked up, a URL on a fake host
 * fetched without credentials (so Slack's `url_private` is refused, as OpenAI refuses it).
 * URLs elsewhere aren't fetched, and are recorded as given.
 */
export async function readPart(part: ModelPart, store: MediaStore, fetchFake: FetchFake): Promise<ModelPart> {
  // An upload's part was read with its body.
  if (part.sha256 !== undefined) return part;
  const { pending, ...rest } = part;
  if (part.from === "data") {
    const decoded = decodeData(pending?.data ?? "");
    if (!decoded) {
      throw invalidRequest(
        part.type === "image"
          ? "Invalid image URL: the data URL couldn't be decoded."
          : "Invalid file data: the data couldn't be decoded.",
        null,
        part.type === "image" ? "invalid_image_url" : "invalid_value",
      );
    }
    const format = pending?.format === undefined ? undefined : FORMAT_TYPES[pending.format];
    return partOf(rest, {
      bytes: decoded.bytes,
      mediaType: mediaTypeOf(decoded.bytes, decoded.mediaType ?? format, part.filename),
    });
  }
  if (part.from === "file_id") {
    const file = part.fileId === undefined ? undefined : store.files.get(part.fileId);
    if (!file) {
      throw invalidRequest(`The file '${part.fileId ?? ""}' was not found.`, null, "file_not_found");
    }
    return partOf(rest, file);
  }
  const url = part.url ?? "";
  const fetched = fetchFake(url);
  if (fetched === undefined) return rest;
  const response = await fetched;
  if (!response.ok) {
    throw new OpenAIError(400, {
      message: `Error while downloading ${url}.`,
      type: "invalid_request_error",
      param: "url",
      code: part.type === "image" ? "invalid_image_url" : "invalid_file_url",
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  return partOf(rest, { bytes, mediaType: mediaTypeOf(bytes, header === "" ? undefined : header) });
}

/** What a file is: by its first bytes, then what it was declared as, then its name's extension. */
export const mediaTypeOf = (bytes: Uint8Array, declared?: string, filename?: string): string =>
  sniff(bytes) ?? declared ?? byExtension(filename) ?? "application/octet-stream";

/** The image formats OpenAI reads, as it lists them when it refuses another. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * A part with what its bytes are: media type, size, SHA-256. An image part that isn't a PNG,
 * JPEG, GIF or WebP is refused as OpenAI refuses it (`invalid_image_format`).
 */
export function partOf(part: Omit<ModelPart, "pending">, media: Media): ModelPart {
  if (part.type === "image" && !IMAGE_TYPES.includes(media.mediaType)) {
    throw invalidRequest(
      "You uploaded an unsupported image. Please make sure your image has of one the following formats: ['png', 'jpeg', 'gif', 'webp'].",
      null,
      "invalid_image_format",
    );
  }
  const filename = part.filename ?? media.filename;
  return {
    ...part,
    mediaType: media.mediaType,
    bytes: media.bytes.length,
    sha256: sha256(media.bytes),
    ...(filename === undefined ? {} : { filename }),
  };
}
