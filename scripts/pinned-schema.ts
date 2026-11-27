/**
 * `pnpm resend:schema --check`, `pnpm google:schema --check`, `pnpm twilio:schema --check`: a
 * platform's own description of its API, as the tests hold its fake to it (exit checks 8.3, 9.2 and
 * 10.2). Each is the platform's file, committed byte for byte from a repository at a commit;
 * `--check` fails when it isn't that file, and `--fetch` downloads it again.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  // Twilio's OpenAPI description of its REST API, version 2010-04-01 (Messages among it).
  twilio: {
    what: "Twilio's twilio_api_v2010.json",
    repository: "twilio/twilio-oai",
    file: "spec/json/twilio_api_v2010.json",
    commit: "6891362428239e2b29339718ffb7bd9fb86ff9cb",
    blob: "dc0d18bb8f39c7b0769ee288b1e871c29a8935ee",
    path: "twilio-api-v2010.json",
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
  writeFileSync(path, bytes);
}
if (blobSha(readFileSync(path)) !== pin.blob) {
  console.error(`${name}:schema: ${path} isn't ${pin.what} at ${pin.commit}. Run \`pnpm ${name}:schema --fetch\`.`);
  process.exit(1);
}
console.log(`${name}:schema: the file is ${pin.what} at`, pin.commit);
