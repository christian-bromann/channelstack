import { defineConfig as viteDefine } from "vitest/config";
import channelstack from "channelstack/vitest";
import { defineConfig } from "channelstack";
export const vitestConfig = viteDefine({ plugins: [channelstack({ mode: "auto", quietFor: "1s" })] });
export const channelstackConfig = defineConfig({
  slack: { app: { name: "my-agent", manifest: "./slack-manifest.yaml", urls: { events: "https://my-agent.localhost/slack/events" } } },
  github: { app: { name: "my-agent", webhook: "https://my-agent.localhost/github", permissions: { issues: "write", pull_requests: "write", checks: "write" }, events: ["issue_comment", "pull_request_review_comment"] } },
  linear: { app: { name: "my-agent", webhook: "https://my-agent.localhost/linear" } },
  notion: { integration: { name: "my-agent", webhook: "https://my-agent.localhost/notion", events: ["comment.created"] } },
});
