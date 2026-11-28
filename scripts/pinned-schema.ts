/**
 * `pnpm resend:schema --check`, `pnpm google:schema --check`, `pnpm discord:schema --check`,
 * `pnpm openai:schema --check`: a platform's own description of its API, as the tests hold its fake
 * to it (exit checks 8.3, 9.2, 11.2 and 13.2). Each is the platform's file, committed byte for byte
 * from a repository at a commit (gzipped, when it is large); `--check` fails when it isn't that file,
 * and `--fetch` downloads it again.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { ROOT } from "./lib/generate.ts";

interface Pin {
  /** What the file is, for the messages. */
  readonly what: string;
  /** The repository and the path in it, at `commit`, and the git blob SHA of the file there. */
  readonly repository: string;
  readonly file: string;
  readonly commit: string;
  readonly blob: string;
  /** Where it is committed, under `server/test/schemas/`. */
  readonly path: string;
  /** Committed gzipped: the file is large, and the check is on its bytes once unpacked. */
  readonly gzip?: boolean;
}

const PINS: Readonly<Record<string, Pin>> = {
  // Resend's OpenAPI description.
  resend: {
    what: "Resend's resend.json",
    repository: "resend/resend-openapi",
    file: "resend.json",
    commit: "c1b5da2f73a3ef8c81ea54c1a717da44dd1e27e1",
    blob: "37a79da142a330e6fa95d57f06cf219836638b91",
    path: "resend-openapi.json",
  },
  // Gmail's discovery document, revision 20261106.
  google: {
    what: "Gmail's discovery document",
    repository: "googleapis/discovery-artifact-manager",
    file: "discoveries/gmail.v1.json",
    commit: "e64e26ab87c7d621285fb6ab4e448436da3dffcb",
    blob: "b6af15b7d871f4d6a218ab810bf50e19d3e6289e",
    path: "gmail-discovery.json",
  },
  // Discord's OpenAPI description, as of 2026-11-06.
  discord: {
    what: "Discord's openapi.json",
    repository: "discord/discord-api-spec",
    file: "specs/openapi.json",
    commit: "3a21a01249a763cd47f1dfec3da91c5ba71bb974",
    blob: "e82fca9268d9bbefaa38979fc005101e8d04b3fb",
    path: "discord-openapi.json",
  },
  // OpenAI's OpenAPI description (5 MB, so gzipped).
  openai: {
    what: "OpenAI's openapi.json",
    repository: "openai/openai-openapi",
    file: "openapi.json",
    commit: "abe304d1e5f1264fd3a11499ab57c0d17f5c1df3",
    blob: "4e0f3ea999d13c6d4bc2ce357f0226653a9bac50",
    path: "openai-openapi.json.gz",
    gzip: true,
  },
};

const name = process.argv[2] ?? "";
const pin = PINS[name];
if (!pin) throw new Error(`Say which schema: ${Object.keys(PINS).join(", ")}`);
const source = `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${pin.file}`;
const path = join(ROOT, "server", "test", "schemas", pin.path);

/** The SHA git gives a blob: what GitHub shows for the file, so the download can be checked against it. */
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

if (process.argv.includes("--fetch")) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (blobSha(bytes) !== pin.blob)
    throw new Error(`The file at ${pin.commit} isn't the blob ${pin.blob}: update both together`);
  writeFileSync(path, pin.gzip ? gzipSync(bytes, { level: 9 }) : bytes);
}
const stored = readFileSync(path);
if (blobSha(pin.gzip ? gunzipSync(stored) : stored) !== pin.blob) {
  console.error(`${name}:schema: ${path} isn't ${pin.what} at ${pin.commit}. Run \`pnpm ${name}:schema --fetch\`.`);
  process.exit(1);
}
console.log(`${name}:schema: the file is ${pin.what} at`, pin.commit);
