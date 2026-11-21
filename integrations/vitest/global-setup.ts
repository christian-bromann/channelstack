import type { TestProject } from "vitest/node";

import { launch } from "../../sdks/typescript/runtime/launcher.ts";
import { type ChannelstackIntegrationOptions, OPTIONS_ENV } from "./index.ts";

/** Runs once per test run: find or start the server, and tell the test workers where it is. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const options = JSON.parse(project.config.env[OPTIONS_ENV] ?? "{}") as ChannelstackIntegrationOptions;
  const server = await launch({
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.server ? { server: options.server } : {}),
  });
  project.provide("channelstack", {
    url: server.url,
    token: server.token,
    timeout: options.timeout ?? "10s",
    quietFor: options.quietFor ?? "750ms",
  });
  return () => server.stop();
}
