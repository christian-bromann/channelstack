/**
 * `pnpm test:rust`: the Rust SDK and its smoke runner, linted with clippy (warnings are errors),
 * and the SDK's own tests, its typed API against the server binary (`CHANNELSTACK_SERVER_BIN`, or
 * the one `pnpm build:binary` compiled for this machine).
 */
import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { run } from "./lib/process.ts";

const env = { ...process.env, CHANNELSTACK_SERVER_BIN: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath() };
run("cargo", ["clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"], { cwd: ROOT, env });
run("cargo", ["test", "--locked", "--workspace"], { cwd: ROOT, env });
