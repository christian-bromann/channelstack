import type { BrowserActor } from "../../../core/browser/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { liveMisconfigured } from "../../../core/reality/index.ts";

/** Slack's web client: the only origin the Slack browser actor opens. */
export const SLACK_CLIENT = "https://app.slack.com";

/** Where Slack keeps a signed-in session: its cookies on these domains. */
export const SLACK_COOKIE_DOMAINS = ["slack.com"] as const;

/** A page of the signed-in client, not a sign-in page Slack sent a signed-out person to. */
export const signedInToSlack = (url: string) => url.startsWith(`${SLACK_CLIENT}/client/`);

/** What a person types: text, and mentions picked from Slack's suggestions by the handle. */
export type Typed = Array<{ text: string } | { mention: string }>;

/**
 * Selectors of Slack's web client, in one place: they are the part of live mode most likely to
 * change (implementation plan 8.5), and only the nightly live job uses them.
 */
const SELECTORS = {
  /** The message composer of the conversation in view. */
  composer: '[data-qa="message_input"] [contenteditable="true"]',
  /** The composer of the thread pane. */
  threadComposer: '[data-qa="threads_flexpane"] [data-qa="message_input"] [contenteditable="true"]',
  /** A button with this label in the messages in view; the newest one when there are several. */
  button: (label: string, pane: "conversation" | "thread") =>
    `(${pane === "thread" ? '//*[@data-qa="threads_flexpane"]' : ""}//button[normalize-space(.)=${JSON.stringify(label)}])[last()]`,
  // A DM with an app in Slack's agent view shows its one thread in the main pane (the Chat tab),
  // with no thread pane: there, the conversation's own composer and buttons are the thread's.
} as const;

/** How long Slack's mention suggestions take to show the match, before Tab picks it. */
const SUGGESTIONS_MS = 800;

const conversationUrl = (team: string, channel: string) => `${SLACK_CLIENT}/client/${team}/${channel}`;
const threadUrl = (team: string, channel: string, ts: string) =>
  `${SLACK_CLIENT}/client/${team}/${channel}/thread/${channel}-${ts}`;

/** Type into the composer that has the focus: text as it is, a mention as `@handle` picked from the suggestions. */
async function compose(actor: BrowserActor, typed: Typed): Promise<void> {
  for (const piece of typed) {
    if ("text" in piece) {
      await actor.type(piece.text);
      continue;
    }
    await actor.type(`@${piece.mention}`);
    await actor.pause(SUGGESTIONS_MS);
    await actor.press("Tab");
  }
  await actor.press("Enter");
}

/**
 * A person in Slack's web client, as the browser actor drives it. `person` names them in the
 * refusal when their saved session is signed out (Slack ends it when they sign out, or after a while).
 */
export function slackClient(actor: BrowserActor, team: string, person: { name: string; login: string }) {
  const signedOut = () =>
    liveMisconfigured(
      `${person.name}'s saved Slack session is signed out`,
      `sign in again: channelstack login slack --user ${person.login}`,
    );
  /** Open a page of the client and act on it: a sign-in page instead of the client is said as such. */
  const on = async (url: string, act: () => Promise<void>) => {
    await actor.open(url);
    if (!signedInToSlack(await actor.url())) throw signedOut();
    try {
      await act();
    } catch (error) {
      // Slack can send a signed-out person to its sign-in page after the client began to load.
      if (error instanceof ProtocolError && error.code === "not_shown" && !signedInToSlack(await actor.url())) {
        throw signedOut();
      }
      throw error;
    }
  };
  return {
    /** Write a message in a conversation, as a person does: in the composer, then Enter. */
    say: (channel: string, typed: Typed) =>
      on(conversationUrl(team, channel), async () => {
        await actor.click(SELECTORS.composer);
        await compose(actor, typed);
      }),

    /** Reply in a thread: in the thread pane's composer. */
    reply: (channel: string, rootTs: string, typed: Typed) =>
      on(threadUrl(team, channel, rootTs), async () => {
        await actor.click([SELECTORS.threadComposer, SELECTORS.composer]);
        await compose(actor, typed);
      }),

    /** Click a button by its label, on a message in a conversation or in a thread. */
    click: (label: string, where: { channel: string; thread?: string | undefined }) =>
      on(
        where.thread === undefined
          ? conversationUrl(team, where.channel)
          : threadUrl(team, where.channel, where.thread),
        () =>
          actor.click(
            where.thread === undefined
              ? SELECTORS.button(label, "conversation")
              : [SELECTORS.button(label, "thread"), SELECTORS.button(label, "conversation")],
          ),
      ),
  };
}
