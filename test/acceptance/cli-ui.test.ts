import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, test } from "vitest";
import { remote } from "webdriverio";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";
import { waitFor } from "../../sdks/typescript/runtime/wait.ts";

// Exit check 1.6: the CLI and the UI. A person at a terminal talks to the agent and reads its
// answer; a browser opens the UI and finds the same answer in the transcript.
test("the attach CLI talks to the agent, and the UI shows the same conversation", async () => {
  const bin = process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  await withStack(
    {
      bin,
      agent: join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
    },
    async ({ env }) => {
      const cli = (...args: string[]) => {
        const result = spawnSync(bin, args, { env, encoding: "utf8" });
        if (result.status !== 0) throw new Error(`channelstack ${args.join(" ")} failed: ${result.stderr}`);
        return result.stdout;
      };
      const reply = 'my-agent: Here\'s what I found about "hi".';

      expect(cli("slack", "say", "--as", "ana", "--in", "#support", "@my-agent hi")).toMatch(
        /^ana said it in #support/,
      );
      const shown = await waitFor("the agent's reply in `channelstack show`", async () =>
        cli("show").includes(reply) ? cli("show") : undefined,
      );
      expect(shown).toBe(`ana: @my-agent hi\n  ${reply}\n`);

      // A second person joins the thread without any setup, and `tail` shows what went back and forth.
      expect(cli("slack", "reply", "--as", "ben", "--thread", "last", "and the one before?")).toMatch(/^ben replied/);
      expect(cli("slack", "react", "--as", "ben", ":eyes:", "--on", "last")).toMatch(/^ben reacted with :eyes:/);
      await waitFor("the agent's second reply", async () =>
        cli("show", "--thread", "last").includes('and the one before?".') ? true : undefined,
      );
      const tail = cli("tail", "--once");
      expect(tail).toMatch(/→ slack app_mention {2}200/);
      expect(tail).toMatch(/← slack chat\.postMessage {2}200/);
      expect(tail).toMatch(/→ slack reaction_added {2}200/);

      // Mistakes are answered in a sentence, with exit code 1.
      const mistake = spawnSync(bin, ["slack", "say", "--in", "#support", "hi"], { env, encoding: "utf8" });
      expect(mistake.status).toBe(1);
      expect(mistake.stderr).toContain("say who is acting with `--as <name>`");

      const browser = await remote({
        logLevel: "error",
        capabilities: {
          browserName: "chrome",
          "goog:chromeOptions": { args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=1200,800"] },
        },
      });
      try {
        // Without the login link there is nothing to see.
        const link = cli("ui").trim();
        await browser.url(new URL("/", link).href);
        expect(await browser.$("body").getText()).toContain("Open the UI with a login link");

        await browser.url(link);
        const transcript = browser.$('[data-testid="transcript"]');
        await browser.waitUntil(async () => (await transcript.getText()).includes(reply), {
          timeout: 10_000,
          timeoutMsg: "The UI never showed the agent's reply in the transcript",
        });
        expect(await transcript.getText()).toContain("ana: @my-agent hi");
        expect(await transcript.getText()).toContain("ben: and the one before?");
        // The login code is gone from the address, and the inspector lists the agent's call.
        expect(await browser.getUrl()).not.toContain("login=");
        expect(await browser.$('[data-testid="inspector"]').getText()).toContain("← slack chat.postMessage");
      } finally {
        await browser.deleteSession();
      }

      // A button the agent shows can be pressed from the terminal, and Stop too.
      cli("slack", "say", "--as", "ana", "--in", "#deploys", "@my-agent deploy web to staging");
      await waitFor("the agent's question", async () => (cli("show").includes("[Approve]") ? true : undefined));
      // An action of Slack's own, from its routes: the button by its label, in the latest conversation.
      expect(cli("slack", "click", "--as", "ana", "Approve")).toMatch(/^ana did click on C\w+:\d+\.\d+\n$/);
      // Without `--as`, whoever started the thread presses Stop.
      expect(cli("slack", "stop", "--thread", "last")).toMatch(/^ana did stop/);
      expect(cli("tail", "--once")).toMatch(/→ slack agent_session_stopped {2}200/);
    },
  );
}, 120_000);
