import { type TranscriptEntry, type TranscriptPrincipal, transcriptText } from "../../core/router/inspect.ts";
import { snowflakeTime } from "./ids.ts";
import type { DiscordMessageRecord } from "./world.ts";

/** One line of a Discord transcript: every channel's fields, and what Discord shows besides. */
export interface DiscordTranscriptEntry extends TranscriptEntry {
  /** Discord's reply: whose message this one answers, as the line above it in the client says. */
  replyTo?: string;
  /** A deferred response, shown as "my-agent is thinking…" until the app edits it. */
  streaming?: "open";
  visibleTo?: TranscriptPrincipal;
}

/** A message's embeds as a person reads them: each title, then its description and fields. */
function embedText(embeds: readonly unknown[]): string[] {
  return embeds.flatMap((raw) => {
    const embed = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const fields = Array.isArray(embed.fields) ? (embed.fields as Array<Record<string, unknown>>) : [];
    return [
      typeof embed.title === "string" ? embed.title : "",
      typeof embed.description === "string" ? embed.description : "",
      ...fields.map((field) => `${String(field.name ?? "")}: ${String(field.value ?? "")}`),
      typeof (embed.footer as { text?: unknown } | undefined)?.text === "string"
        ? String((embed.footer as { text: string }).text)
        : "",
    ].filter((line) => line !== "");
  });
}

/** The labels of a message's buttons and menus, in the order a person sees them. */
function controlsOf(components: readonly unknown[]): string[] {
  return components.flatMap((row) => {
    const children = (row as { components?: unknown }).components;
    return Array.isArray(children)
      ? children.flatMap((child) => {
          const control = child as { label?: unknown; placeholder?: unknown };
          const label = typeof control.label === "string" ? control.label : control.placeholder;
          return typeof label === "string" ? [label] : [];
        })
      : [];
  });
}

/**
 * Discord state reduced to what a person would read: edits applied, deletes gone, mentions as
 * names, embeds as their text, buttons as controls, a reply under the message it answers, a
 * deferred response as the app thinking, and an ephemeral message only for its person.
 */
export function renderTranscript(
  lines: ReadonlyArray<{ message: DiscordMessageRecord; depth: number }>,
  options: {
    /** Who is reading. Without one, ephemeral messages are left out. */
    viewer: string | undefined;
    principal(userId: string): TranscriptPrincipal;
    /** The name of a mentioned user, or nothing for an id that is nobody the reader's session knows. */
    mentionName(userId: string): string | undefined;
    /** Who wrote a message this one replies to. */
    replyAuthor(message: DiscordMessageRecord): string | undefined;
    appName: string;
  },
): { entries: DiscordTranscriptEntry[]; text: string } {
  const named = (text: string) =>
    text.replace(/<@!?(\d{17,20})>/g, (whole, id: string) => {
      const name = options.mentionName(id);
      return name === undefined ? whole : `@${name}`;
    });
  const entries = lines
    .filter(({ message }) => message.ephemeralFor === undefined || message.ephemeralFor === options.viewer)
    .map(({ message, depth }): DiscordTranscriptEntry => {
      const loading = (message.flags & (1 << 7)) !== 0;
      const replyTo = message.replyTo === undefined ? undefined : options.replyAuthor(message);
      const text = loading
        ? `${options.appName} is thinking…`
        : [named(message.content), ...embedText(message.embeds)].filter((line) => line !== "").join("\n");
      return {
        id: message.id,
        author: options.principal(message.authorId),
        at: snowflakeTime(message.id),
        text,
        controls: controlsOf(message.components),
        edited: message.editedAt !== undefined,
        depth,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(loading ? { streaming: "open" as const } : {}),
        ...(message.ephemeralFor === undefined ? {} : { visibleTo: options.principal(message.ephemeralFor) }),
      };
    });
  const text = transcriptText(entries, {
    marks: (entry) => [
      entry.replyTo === undefined ? "" : `replying to ${entry.replyTo}`,
      entry.edited ? "edited" : "",
      entry.visibleTo ? `only ${entry.visibleTo.name} sees this` : "",
    ],
    after: (entry) =>
      entry.controls.map((control, index) => `${index === 0 && entry.text === "" ? "" : " "}[${control}]`).join(""),
  });
  return { entries, text };
}
