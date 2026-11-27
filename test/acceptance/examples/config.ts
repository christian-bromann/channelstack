import channelstack from "channelstack/vitest";
import { defineConfig } from "vitest/config";
// There is no channelstack config file: each fake has a built-in app named `my-agent`, and the
// server delivers its events to `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL`.
export const vitestConfig = defineConfig({ plugins: [channelstack({ mode: "auto", quietFor: "1s" })] });
