import { slackTsTime } from "../../core/ids/index.ts";
import { type Block, blockControls, blockText } from "./blocks.ts";
import { nameMentions } from "./mentions.ts";
import type { SlackMessageRecord } from "./world.ts";

/** One line of a transcript, in the shape every channel's transcript has (`api/common.d.ts`). */
export interface TranscriptEntry {
  id: string;
  author: { id: string; name: string; kind: "user" | "app" };
  at: string;
  text: string;
  controls: string[];
  /** The names of the files shared with the message. */
  files: string[];
  /** A reply that was also sent to the channel. */
  alsoInChannel?: true;
  edited: boolean;
  streaming?: "open" | "stopped" | "completed";
  visibleTo?: { id: string; name: string; kind: "user" | "app" };
  depth: number;
}

/**
 * Slack state reduced to what a person would read: edits applied, deleted messages gone, a stream
 * as one message, ephemeral messages only for their recipient, mentions as names, and the text
 * and button labels of blocks. Text matchers and the UI read this view.
 */
export function renderTranscript(
  messages: readonly SlackMessageRecord[],
  options: {
    /** Who is reading. Without one, ephemeral messages are left out. */
    viewer: string | undefined;
    principal(userId: string): { id: string; name: string; kind: "user" | "app" };
    /** The name of a mentioned user, or nothing when the id is nobody the reader's session knows. */
    mentionName(userId: string): string | undefined;
  },
): { entries: TranscriptEntry[]; text: string } {
  const named = (text: string) => nameMentions(text, options.mentionName);
  const entries = messages
    .filter((message) => message.ephemeralFor === undefined || message.ephemeralFor === options.viewer)
    .map((message): TranscriptEntry => {
      const blocks = message.blocks as Block[];
      const fromBlocks = blocks.flatMap(blockText).filter((line) => line !== "");
      return {
        id: message.ts,
        author: options.principal(message.user),
        at: slackTsTime(message.ts),
        // A message's text is what Slack shows when it has no blocks; with blocks, people read the blocks.
        text: named(message.text !== "" ? message.text : fromBlocks.join("\n")),
        controls: blocks.flatMap(blockControls),
        files: message.files.map((file) => file.name),
        ...(message.broadcast ? { alsoInChannel: true as const } : {}),
        edited: message.edited !== undefined,
        ...(message.stream === undefined ? {} : { streaming: message.stream.state }),
        ...(message.ephemeralFor === undefined ? {} : { visibleTo: options.principal(message.ephemeralFor) }),
        depth: message.threadTs === undefined ? 0 : 1,
      };
    });
  // One line per entry, replies indented under their thread: what `toString()` prints and snapshots keep.
  const text = entries
    .map((entry) => {
      const marks = [
        entry.edited ? "edited" : "",
        entry.alsoInChannel ? "also sent to the channel" : "",
        entry.streaming === "open" ? "streaming" : "",
        entry.visibleTo ? `only ${entry.visibleTo.name} sees this` : "",
      ]
        .filter((mark) => mark !== "")
        .join(", ");
      const controls = [...entry.controls, ...entry.files.map((file) => `file: ${file}`)]
        .map((control) => ` [${control}]`)
        .join("");
      return `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${controls}${marks === "" ? "" : ` (${marks})`}`;
    })
    .join("\n");
  return { entries, text };
}
