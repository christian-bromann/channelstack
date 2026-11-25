import type { TestProject } from "vitest/node";

import { launch } from "../../sdks/typescript/runtime/launcher.ts";
import { waitDefaults } from "../../sdks/typescript/runtime/wait.ts";
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
    // Unset, they are the wait module's own defaults: the one place they live.
    timeout: options.timeout ?? waitDefaults().timeout,
    quietFor: options.quietFor ?? waitDefaults().quietFor,
  });
  return () => server.stop();
}
