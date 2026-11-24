import type { Launch } from "../src/core/browser/index.ts";
import type { SlackStub } from "./slack-live-stub.ts";

/**
 * A stand-in for Slack's web client in unit tests of the browser actor: it answers what the actor
 * does (open a page, click the composer or a button, type, press Tab and Enter) over the Slack
 * stub. What a person types and sends arrives there as a message they typed, with no app's bot
 * on it; `@handle` and Tab picks the mention, as Slack's suggestions do. The person is whoever the
 * saved session's `d` cookie names.
 */
export function slackClientStub(stub: SlackStub) {
  const clicks: Array<{ user: string; channel: string; thread: string | undefined; label: string }> = [];
  const opened: string[] = [];
  const launch: Launch = async () => {
    let user = "";
    let page: { channel: string; thread: string | undefined } | undefined;
    let draft: string | undefined;
    const element = (selector: string) => {
      const label = /normalize-space\(\.\)=("(?:[^"\\]|\\.)*")/.exec(selector)?.[1];
      const shown = () => {
        if (!page) return false;
        if (label === undefined) return true;
        const messages = stub.channel(page.channel)?.messages ?? [];
        return messages.some((message) => JSON.stringify(message.blocks ?? []).includes(JSON.parse(label)));
      };
      const self = {
        waitForDisplayed: async () => {
          if (!shown()) throw new Error(`Nothing shown for ${selector}`);
        },
        click: async () => {
          if (!page) throw new Error("No page open");
          if (label === undefined) draft = "";
          else clicks.push({ user, channel: page.channel, thread: page.thread, label: JSON.parse(label) });
        },
        $: () => self,
        isExisting: async () => shown(),
      };
      return self;
    };
    return {
      url: async (url: string) => {
        opened.push(url);
        const match = /\/client\/[^/]+\/([^/]+)(?:\/thread\/[^-]+-(.+))?$/.exec(new URL(url).pathname);
        page = match ? { channel: match[1] as string, thread: match[2] } : undefined;
        draft = undefined;
      },
      getUrl: async () => opened.at(-1) ?? "about:blank",
      setCookies: async (cookies) => {
        user = cookies.find((cookie) => cookie.name === "d")?.value ?? "";
      },
      getCookies: async () => [{ name: "d", value: user, domain: ".slack.com" }],
      $: element,
      keys: async (value: string | string[]) => {
        if (draft === undefined || !page) throw new Error("Nothing to type into");
        if (value === "") {
          // Tab: the mention suggestion for the handle just typed.
          draft = draft.replace(/@([\w.-]+)$/, (typed, handle: string) => {
            const id = stub.userByName(handle);
            return id ? `<@${id}>` : typed;
          });
        } else if (value === "") {
          stub.typed(user, page.channel, draft, page.thread);
          draft = "";
        } else draft += Array.isArray(value) ? value.join("") : value;
      },
      pause: async () => {},
      deleteSession: async () => {},
    };
  };
  return { launch, clicks, opened };
}
