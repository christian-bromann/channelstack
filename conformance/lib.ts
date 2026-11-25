/**
 * The differential run's comparison (implementation plan 9.1): a scenario's recording against the
 * fake and against the real platform, normalized, diffed, and each difference either listed in
 * `divergences.yaml` with a reason and a date it expires, or a failure.
 */
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import { SECRET_FIELD } from "../scenarios/runners/typescript/secrets.ts";

/**
 * Keys whose values differ between any two runs by design: ids, times, links, and the names a
 * sandbox gives its accounts (the agent's app is "my-agent" in the fake and whatever the sandbox
 * app is called live), and how the sandbox app is set up (its scopes). The comparison keeps structure, order and text, and drops these.
 */
const NOISE =
  /^(id|numericId|ts|threadTs|channel|number|identifier|url|htmlUrl|postedAt|createdAt|updatedAt|editedAt|at|key|name|login|displayName|realName|email|botUserId|botLogin|installationId|appId|clientId|repoId|slug|owner|fullName|admin|isAdmin|isOwner|block_id|scopes)$/;
/**
 * Fields the contract says only the fake has (`delivery`: live, the platform delivers to the agent
 * itself). Their absence live is the contract, not drift.
 */
const FAKE_ONLY = new Set(["delivery"]);

/** Ids, times and links inside text, replaced by what they are. */
const IN_TEXT: ReadonlyArray<[RegExp, string]> = [
  [/https?:\/\/[^\s<>|)]+/g, "<url>"],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // Slack's ids (U…, C…, B…, T…, D…, G…, W…) and run-tagged names.
  [/<@[UW][A-Z0-9]{6,}>/g, "<@id>"],
  [/\b[UCBTDGW][A-Z0-9]{8,}\b/g, "<id>"],
  [/channelstack-run-[a-z0-9-]+/g, "<tagged>"],
  // A person's email, which a platform may put in a text: a result file never holds one.
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
  // An issue's key (`ENG-1`): a team's key differs per run.
  [/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, "<issue>"],
  // A mention by name, of the app or a person (Slack's `<@U…>` is an id, above).
  [/(^|[\s(])@[\w.-]+/g, "$1@mention"],
];

/**
 * A recording as it compares: noise and secrets dropped, and text with its ids, links and mentions
 * replaced. A mention is `@mention` whoever it names: the agent's app is "my-agent" in the fake and
 * the sandbox app's own name live, which a recording doesn't always hold.
 */
export function normalize(value: unknown): unknown {
  if (typeof value === "string") return IN_TEXT.reduce((text, [pattern, by]) => text.replace(pattern, by), value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !NOISE.test(key) && !FAKE_ONLY.has(key) && !SECRET_FIELD.test(key))
      .map(([key, item]) => [key, normalize(item)]),
  );
}

export interface Difference {
  /** Where, as a dotted path: `replies.1.text`. */
  path: string;
  fake: unknown;
  live: unknown;
}

/** Every place two normalized recordings differ, by path. A list that differs in length differs at its length. */
export function diff(fake: unknown, live: unknown, path = ""): Difference[] {
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key));
  if (Array.isArray(fake) && Array.isArray(live)) {
    if (fake.length !== live.length) return [{ path: at("length"), fake: fake.length, live: live.length }];
    return fake.flatMap((item, index) => diff(item, live[index], at(index)));
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (object(fake) && object(live)) {
    const keys = [...new Set([...Object.keys(fake), ...Object.keys(live)])].sort();
    return keys.flatMap((key) => diff(fake[key], live[key], at(key)));
  }
  return JSON.stringify(fake) === JSON.stringify(live) ? [] : [{ path: path || "(value)", fake, live }];
}

/** A known difference between a fake and its platform. */
export interface Divergence {
  /** The scenario's name: `slack/mention`. */
  scenario: string;
  /** The difference's path, or a prefix of it ending in `.*` (`replies.*`); or a list of them. */
  path: string | readonly string[];
  /** Why it is allowed, in a sentence. */
  reason: string;
  /** `YYYY-MM-DD`: after this date it is a failure again, until someone looks at it. */
  expires: string;
}

/** Read and check `divergences.yaml`: every entry complete, every date real. */
export function loadDivergences(file: string): Divergence[] {
  const parsed = parse(readFileSync(file, "utf8")) as { divergences?: unknown } | null;
  const list = parsed?.divergences ?? [];
  if (!Array.isArray(list)) throw new Error(`${file}: divergences must be a list`);
  return list.map((entry: Record<string, unknown>, index) => {
    const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
    const missing = ["scenario", "path", "reason", "expires"].filter((key) =>
      key === "path"
        ? !(text(entry?.path) || (Array.isArray(entry?.path) && entry.path.length > 0 && entry.path.every(text)))
        : !text(entry?.[key]),
    );
    if (missing.length > 0) throw new Error(`${file}: divergence ${index + 1} has no ${missing.join(", ")}`);
    const expires = entry.expires as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      throw new Error(`${file}: divergence ${index + 1} expires on "${expires}", not a YYYY-MM-DD date`);
    }
    return entry as unknown as Divergence;
  });
}

/** The divergences that have expired on `today` (`YYYY-MM-DD`). */
export function expired(divergences: readonly Divergence[], today: string): Divergence[] {
  return divergences.filter((divergence) => divergence.expires < today);
}

const covers = (divergence: Divergence, scenario: string, path: string) =>
  divergence.scenario === scenario &&
  (typeof divergence.path === "string" ? [divergence.path] : divergence.path).some(
    (allowed) =>
      allowed === path || allowed === "*" || (allowed.endsWith(".*") && path.startsWith(allowed.slice(0, -1))),
  );

/** A scenario's differences, each with the divergence that allows it, if one does and hasn't expired. */
export function classify(
  scenario: string,
  differences: readonly Difference[],
  divergences: readonly Divergence[],
  today: string,
): Array<Difference & { allowedBy?: Divergence }> {
  const current = divergences.filter((divergence) => divergence.expires >= today);
  return differences.map((difference) => {
    const allowedBy = current.find((divergence) => covers(divergence, scenario, difference.path));
    return allowedBy ? { ...difference, allowedBy } : difference;
  });
}

/** One scenario of a differential run. */
export interface ScenarioResult {
  scenario: string;
  channel: string;
  fake: "passed" | "failed";
  live: "passed" | "failed" | "skipped";
  /** Why live was skipped, or how a run failed. */
  note?: string;
  differences: Array<Difference & { allowedBy?: Divergence }>;
  /** Both recordings as they were compared (normalized: no ids, no secrets), to read a difference by. */
  recordings?: { fake: unknown; live: unknown };
}

/** One operation the shape differ compared: what the platform's shape has that the fake's doesn't. */
export interface ShapeResult {
  channel: string;
  kind: "api" | "webhook";
  /** `POST /api/chat.postMessage`, or a webhook's event type. */
  operation: string;
  /** Each path `<kind> <operation> <path>`, as a divergence names it (scenario `shapes/<channel>`). */
  differences: Array<Difference & { allowedBy?: Divergence }>;
}

export interface ConformanceResults {
  /** When the run ended, ISO. */
  at: string;
  /** Whether live ran at all (`--fake-only` or no credentials: it didn't). */
  live: boolean;
  /** The shape differ's operations (implementation plan 9.2); none when live didn't run. */
  shapes: ShapeResult[];
  scenarios: ScenarioResult[];
  /** Divergences whose date has passed: each one fails the run until someone looks at it. */
  expired: Divergence[];
}
