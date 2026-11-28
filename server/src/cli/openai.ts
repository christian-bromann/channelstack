import { type Attached, CliError, segment } from "./attach.ts";

/** What `channelstack openai` takes beyond its words. */
export interface OpenAIFlags {
  /** Answer only calls whose newest user message has this text. */
  readonly when?: string | undefined;
  /** How many calls it answers (`-1`: all of them). */
  readonly times?: string | undefined;
  /** Call this tool first, with `--args` as its JSON arguments, and answer with the text after it. */
  readonly tool?: string | undefined;
  readonly args?: string | undefined;
}

interface Script {
  readonly id: string;
  readonly times: number;
}

interface Call {
  readonly id: string;
  readonly endpoint: string;
  readonly model: string;
  readonly at: string;
  readonly script?: string;
  readonly request: { readonly lastUserText?: string };
  readonly response: { readonly status: number; readonly text?: string; readonly error?: string };
}

const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

/**
 * `channelstack openai respond|calls|undo`: the fake OpenAI in the dev session (decision 0029). A
 * text may use templates (`{lastUserText}`, `{toolResult}`): the CLI has no function to run.
 */
export async function runOpenAI(
  server: Attached,
  action: string | undefined,
  words: readonly string[],
  flags: OpenAIFlags,
): Promise<string> {
  const base = `/sessions/${segment(await server.devSession())}/openai`;
  if (action === "respond") {
    const text = words.join(" ");
    if (text === "" && flags.tool === undefined)
      throw new CliError('say what the model answers: `channelstack openai respond "…"`');
    let toolArgs: unknown = {};
    if (flags.args !== undefined) {
      try {
        toolArgs = JSON.parse(flags.args);
      } catch {
        throw new CliError(`--args is the tool's arguments as JSON, not ${JSON.stringify(flags.args)}`);
      }
    }
    const turns =
      flags.tool === undefined
        ? [text]
        : [{ toolCalls: [{ name: flags.tool, arguments: toolArgs }] }, ...(text === "" ? [] : [text])];
    const times = flags.times === undefined ? undefined : Number(flags.times);
    if (times !== undefined && !Number.isInteger(times))
      throw new CliError(`--times is a whole number, not "${flags.times}"`);
    const script = await server.request<Script>("POST", `${base}/scripts`, {
      turns,
      ...(flags.when === undefined ? {} : { when: { text: flags.when } }),
      ...(times === undefined ? {} : { times }),
    });
    const answers =
      script.times === -1 ? "every matching call" : `${script.times} ${script.times === 1 ? "call" : "calls"}`;
    return `${script.id}: the model answers ${answers}${flags.when === undefined ? "" : ` about "${flags.when}"`}\n`;
  }
  if (action === "calls") {
    const calls = await server.request<Call[]>("GET", `${base}/calls`);
    if (calls.length === 0) return "No model calls yet.\n";
    return calls
      .map((call) => {
        const asked = call.request.lastUserText === undefined ? "" : ` "${excerpt(call.request.lastUserText)}"`;
        const answer =
          call.response.error !== undefined
            ? `${call.response.status} ${call.response.error}`
            : `${call.response.status}${call.response.text ? ` "${excerpt(call.response.text)}"` : ""}`;
        return `${call.id}  ${call.endpoint} ${call.model}${asked} → ${answer}${call.script ? ` (${call.script})` : ""}\n`;
      })
      .join("");
  }
  if (action === "undo") {
    const [script] = words;
    if (script === undefined) throw new CliError("say which script: `channelstack openai undo ms_…`");
    await server.request("DELETE", `${base}/scripts/${segment(script)}`);
    return `Removed ${script}.\n`;
  }
  throw new CliError(`unknown openai command "${action ?? ""}": respond, calls or undo`);
}
