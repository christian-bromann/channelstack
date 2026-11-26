/**
 * `pnpm resend:schema --check`: Resend's OpenAPI description, as the tests hold the fake to it
 * (exit check 8.3). `server/test/schemas/resend-openapi.json` is Resend's own `resend.json` from
 * `resend/resend-openapi`, committed as it is; `--check` fails when it isn't that file at `COMMIT`,
 * and `--fetch` downloads it again.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./lib/generate.ts";

/** The commit of resend/resend-openapi the description is taken from, and the git blob SHA of the file there. */
const COMMIT = "c1b5da2f73a3ef8c81ea54c1a717da44dd1e27e1";
const BLOB = "37a79da142a330e6fa95d57f06cf219836638b91";
const SOURCE = `https://raw.githubusercontent.com/resend/resend-openapi/${COMMIT}/resend.json`;
const path = join(ROOT, "server", "test", "schemas", "resend-openapi.json");

/** The SHA git gives a blob: what GitHub shows for the file, so the download can be checked against it. */
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

if (process.argv.includes("--fetch")) {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (blobSha(bytes) !== BLOB)
    throw new Error(`The description at ${COMMIT} isn't the blob ${BLOB}: update both together`);
  writeFileSync(path, bytes);
}
if (blobSha(readFileSync(path)) !== BLOB) {
  console.error(`resend:schema: ${path} isn't Resend's resend.json at ${COMMIT}. Run \`pnpm resend:schema --fetch\`.`);
  process.exit(1);
}
console.log("resend:schema: the description is Resend's at", COMMIT);
