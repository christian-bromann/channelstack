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

/**
 * Every recorded operation, its shapes merged: `api slack POST /api/chat.postMessage` → its shape.
 * A refusal has its own shape (`{ ok: false, error }`, a 4xx, a GraphQL answer with `errors`), so
 * it is its own operation (`… refused`): the error codes the platform answers with are compared
 * with the fake's, apart from the answers that worked.
 */
export function readShapes(files: readonly string[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const recorded = JSON.parse(line) as RecordedShape;
      const shape = recorded.shape;
      const refused =
        recorded.kind === "api" &&
        ((recorded.status ?? 200) >= 400 ||
          (typeof shape === "object" &&
            !Array.isArray(shape) &&
            (shape.ok === "=false" || shape.errors !== undefined)));
      const key = `${recorded.kind} ${recorded.channel} ${recorded.operation}${refused ? " refused" : ""}`;
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
    // Codes on both sides (`=message`, `=channel_not_found`): every code the platform sent there
    // must be one the fake sends too.
    const codes = (shape: string) => shape.split("|").filter((type) => type !== "null");
    if ([...codes(fake), ...codes(live)].every((type) => type.startsWith("="))) {
      const missing = codes(live).filter((code) => !codes(fake).includes(code));
      return codes(fake).length === 0 || missing.length === 0
        ? []
        : [{ path: path || "(value)", fake, live: missing.join("|") }];
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
