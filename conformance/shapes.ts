/**
 * The shape differ (implementation plan 9.2): the shapes the recorder wrote for the fake and for
 * the platform, operation by operation, compared. It catches drift in endpoints and webhooks no
 * scenario asserts on.
 *
 * What it reports: a key the platform sends that the fake doesn't, a value whose types differ
 * with nothing in common, and a kept code (`type`, `error`, `ok`) the platform sends that the
 * fake never does where the fake sends codes there too. A key only the fake sends isn't reported: the platform leaves out
 * optional fields its data doesn't have, which a single run can't tell from drift.
 */
import { existsSync, readFileSync } from "node:fs";

import { mergeShapes, type RecordedShape, type Shape } from "../server/src/core/proxy/record.ts";
import type { Difference } from "./lib.ts";

/** Every recorded operation, its shapes merged: `api slack POST /api/chat.postMessage` → its shape. */
export function readShapes(files: readonly string[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const recorded = JSON.parse(line) as RecordedShape;
      // A refusal has its own shape (`{ ok: false, error }`): only answers that worked are compared.
      if (recorded.kind === "api" && (recorded.status ?? 200) >= 400) continue;
      // Slack's `{ ok: false }` and a GraphQL answer with `errors` are refusals too.
      if (recorded.kind === "api" && typeof recorded.shape === "object" && !Array.isArray(recorded.shape)) {
        if (recorded.shape.ok === "=false" || recorded.shape.errors !== undefined) continue;
      }
      const key = `${recorded.kind} ${recorded.channel} ${recorded.operation}`;
      const known = shapes.get(key);
      shapes.set(key, known === undefined ? recorded.shape : mergeShapes(known, recorded.shape));
    }
  }
  return shapes;
}

const types = (shape: string) => new Set(shape.split("|").map((type) => (type.startsWith("=") ? "string" : type)));

/** Where the fake's shape lacks what the platform's has, or disagrees on a type. */
export function compareShapes(fake: Shape, live: Shape, path = ""): Difference[] {
  const at = (key: string) => (path ? `${path}.${key}` : key);
  const object = (shape: Shape): shape is { [key: string]: Shape } =>
    typeof shape === "object" && !Array.isArray(shape);
  if (object(fake) && object(live)) {
    return Object.entries(live).flatMap(([key, shape]) =>
      fake[key] === undefined
        ? [{ path: at(key), fake: undefined, live: shape }]
        : compareShapes(fake[key] as Shape, shape, at(key)),
    );
  }
  if (Array.isArray(fake) && Array.isArray(live)) {
    // An empty list says nothing about its items.
    return fake[0] === undefined || live[0] === undefined ? [] : compareShapes(fake[0], live[0], at("[]"));
  }
  if (typeof fake === "string" && typeof live === "string") {
    // Codes on both sides (`=message`, `=channel_not_found`): the platform's must be among the fake's.
    const codes = (shape: string) => shape.split("|").filter((type) => type !== "null");
    if ([...codes(fake), ...codes(live)].every((type) => type.startsWith("="))) {
      const theirs = codes(live);
      return theirs.length === 0 || codes(fake).length === 0 || theirs.some((code) => codes(fake).includes(code))
        ? []
        : [{ path: path || "(value)", fake, live }];
    }
    const mine = types(fake);
    // `null` next to a type only says the value was missing once.
    const theirs = [...types(live)].filter((type) => type !== "null");
    return theirs.length === 0 || theirs.some((type) => mine.has(type))
      ? []
      : [{ path: path || "(value)", fake, live }];
  }
  return JSON.stringify(fake) === JSON.stringify(live) ? [] : [{ path: path || "(value)", fake, live }];
}
