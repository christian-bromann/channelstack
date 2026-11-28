/**
 * `pnpm openai:shapes [--fake-only] [--out <file>]`: the fake OpenAI's shape lane (exit check
 * 13.13, decision 0029). The same requests go to the fake, in process, and to the real API with a
 * cheap model: text, a tool call and a refusal on both endpoints, streamed and not, and
 * `GET /v1/models`. Each answer is reduced to its shape (a stream to one shape per event type), and
 * the differ compares the fake's with the real API's, as the other channels' nightly run does: a
 * key the real API sends that the fake doesn't, or a type with nothing in common, fails the run
 * unless `conformance/divergences.yaml` allows it under `shapes/openai`.
 *
 * The real side needs `CHANNELSTACK_OPENAI_LIVE_KEY` (and takes `CHANNELSTACK_OPENAI_LIVE_MODEL`,
 * default `gpt-5-nano`). Without the key, or with `--fake-only`, only the fake side runs: each
 * request still has to be answered, so the lane is known to work before it has a key.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { classify, type Difference, type Divergence, expired, loadDivergences } from "../conformance/lib.ts";
import { compareShapes } from "../conformance/shapes.ts";
import { mergeShapes, type Shape, shapeOf } from "../server/src/core/proxy/record.ts";
import { harness } from "../server/test/app-harness.ts";
import { ROOT } from "./lib/generate.ts";

/** One request of the lane, and what the fake's script answers it with. */
interface Case {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  /** The request body, without `model` (the lane sets it). */
  readonly body?: Record<string, unknown>;
  /** The fake's turn for it; none for a request no script answers (`GET /v1/models`). */
  readonly turn?: unknown;
}

const weather = {
  name: "get_weather",
  description: "The weather in a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};
const toolTurn = { toolCalls: [{ name: "get_weather", arguments: { city: "Berlin" } }] };
const ask = "Say hello in one word.";
const askTool = "What is the weather in Berlin? Use the tool.";

const CASES: readonly Case[] = [
  { name: "models", method: "GET", path: "/v1/models" },
  {
    name: "chat text",
    method: "POST",
    path: "/v1/chat/completions",
    body: { messages: [{ role: "user", content: ask }] },
    turn: "Hello.",
  },
  {
    name: "chat text stream",
    method: "POST",
    path: "/v1/chat/completions",
    body: { messages: [{ role: "user", content: ask }], stream: true, stream_options: { include_usage: true } },
    turn: "Hello.",
  },
  {
    name: "chat tool call",
    method: "POST",
    path: "/v1/chat/completions",
    body: {
      messages: [{ role: "user", content: askTool }],
      tools: [{ type: "function", function: weather }],
      tool_choice: "required",
    },
    turn: toolTurn,
  },
  {
    name: "chat tool call stream",
    method: "POST",
    path: "/v1/chat/completions",
    body: {
      messages: [{ role: "user", content: askTool }],
      tools: [{ type: "function", function: weather }],
      tool_choice: "required",
      stream: true,
      stream_options: { include_usage: true },
    },
    turn: toolTurn,
  },
  {
    name: "responses text",
    method: "POST",
    path: "/v1/responses",
    body: { input: ask, store: false },
    turn: "Hello.",
  },
  {
    name: "responses text stream",
    method: "POST",
    path: "/v1/responses",
    body: { input: ask, store: false, stream: true },
    turn: "Hello.",
  },
  {
    name: "responses tool call",
    method: "POST",
    path: "/v1/responses",
    body: { input: askTool, store: false, tools: [{ type: "function", ...weather }], tool_choice: "required" },
    turn: toolTurn,
  },
  {
    name: "responses tool call stream",
    method: "POST",
    path: "/v1/responses",
    body: {
      input: askTool,
      store: false,
      tools: [{ type: "function", ...weather }],
      tool_choice: "required",
      stream: true,
    },
    turn: toolTurn,
  },
  {
    name: "responses unknown id",
    method: "GET",
    path: "/v1/responses/resp_0000000000000000000000000000000000000000000000000",
  },
];

/** An answer's shapes by operation: one for a JSON body, one per event type for a stream. */
async function shapesOf(name: string, response: Response): Promise<Map<string, Shape>> {
  const shapes = new Map<string, Shape>();
  const add = (key: string, shape: Shape) => {
    const known = shapes.get(key);
    shapes.set(key, known === undefined ? shape : mergeShapes(known, shape));
  };
  const refused = response.status >= 400 ? " refused" : "";
  if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    add(`api openai ${name}${refused}`, shapeOf(await response.json()));
    return shapes;
  }
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
    // Chat Completions' chunks have no type: a chunk with choices, and the usage chunk after them.
    const kind =
      typeof event.type === "string"
        ? event.type
        : Array.isArray(event.choices) && event.choices.length > 0
          ? "chunk"
          : "usage chunk";
    add(`api openai ${name} event ${kind}`, shapeOf(event));
  }
  return shapes;
}

/** The fake's answers, in process: a session, a script per case, and the request in its name. */
async function fakeShapes(): Promise<Map<string, Shape>> {
  const h = harness();
  const { sessionId } = (await h.call("POST", "/sessions", { name: "openai-shapes" })).body;
  const apiKey = h.secrets.get("openai", "apiKey");
  const shapes = new Map<string, Shape>();
  for (const lane of CASES) {
    if (lane.turn !== undefined) {
      const scripted = await h.call("POST", `/sessions/${sessionId}/openai/scripts`, { turns: [lane.turn] });
      if (scripted.status >= 400)
        throw new Error(`${lane.name}: the fake refused the script: ${scripted.body.message}`);
    }
    const response = await h.app.fetch(
      new Request(`http://127.0.0.1:4500/openai${lane.path}`, {
        method: lane.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-channelstack-session": sessionId,
        },
        ...(lane.body ? { body: JSON.stringify({ model: "gpt-5-nano", ...lane.body }) } : {}),
      }),
    );
    const expected = lane.name.endsWith("unknown id") ? 404 : 200;
    if (response.status !== expected) {
      throw new Error(`${lane.name}: the fake answered ${response.status}, not ${expected}: ${await response.text()}`);
    }
    for (const [key, shape] of await shapesOf(lane.name, response)) shapes.set(key, shape);
  }
  return shapes;
}

/** The real API's answers to the same requests. */
async function liveShapes(key: string, model: string): Promise<Map<string, Shape>> {
  const shapes = new Map<string, Shape>();
  for (const lane of CASES) {
    const response = await fetch(`https://api.openai.com${lane.path}`, {
      method: lane.method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(lane.body ? { body: JSON.stringify({ model, ...lane.body }) } : {}),
    });
    const expected = lane.name.endsWith("unknown id") ? 404 : 200;
    if (response.status !== expected) {
      // The body is OpenAI's error, which names no secret; the key never goes into output.
      throw new Error(`${lane.name}: OpenAI answered ${response.status}, not ${expected}: ${await response.text()}`);
    }
    for (const [name, shape] of await shapesOf(lane.name, response)) shapes.set(name, shape);
  }
  return shapes;
}

interface LaneResult {
  operation: string;
  differences: Array<Difference & { allowedBy?: Divergence }>;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "fake-only": { type: "boolean", default: false },
      out: { type: "string", default: join(ROOT, "build", "conformance", "openai-shapes.json") },
    },
  });
  // CI passes an unset variable as an empty one.
  const key = process.env.CHANNELSTACK_OPENAI_LIVE_KEY || undefined;
  const model = process.env.CHANNELSTACK_OPENAI_LIVE_MODEL || "gpt-5-nano";
  const fake = await fakeShapes();
  console.log(`openai shapes: the fake answered all ${CASES.length} requests (${fake.size} shapes)`);
  if (values["fake-only"] || !key) {
    if (!key && !values["fake-only"]) {
      console.log("openai shapes: waiting for CHANNELSTACK_OPENAI_LIVE_KEY, so the real side is skipped (13.13)");
    }
    return;
  }

  const live = await liveShapes(key, model);
  const divergences = loadDivergences(join(ROOT, "conformance", "divergences.yaml"));
  const today = new Date().toISOString().slice(0, 10);
  const results: LaneResult[] = [...live].map(([operation, liveShape]) => {
    const fakeShape = fake.get(operation);
    const differences: Difference[] =
      fakeShape === undefined
        ? [{ path: operation, fake: undefined, live: "sent by OpenAI, never by the fake" }]
        : compareShapes(fakeShape, liveShape).map((difference) => ({
            ...difference,
            path: `${operation} ${difference.path}`,
          }));
    return { operation, differences: classify("shapes/openai", differences, divergences, today) };
  });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify({ model, results }, null, 2)}\n`);

  const failures = [
    ...results.flatMap((result) =>
      result.differences
        .filter((difference) => difference.allowedBy === undefined)
        .map(
          (difference) =>
            `shapes/openai: ${difference.path} is ${JSON.stringify(difference.fake ?? "missing")} in the fake and ${JSON.stringify(difference.live)} live`,
        ),
    ),
    ...expired(divergences, today)
      .filter((divergence) => divergence.scenario === "shapes/openai")
      .map(
        (divergence) => `shapes/openai: the divergence for ${String(divergence.path)} expired on ${divergence.expires}`,
      ),
  ];
  console.log(`openai shapes: ${results.length} operations compared against ${model}, ${failures.length} failing`);
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
