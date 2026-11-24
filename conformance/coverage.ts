/**
 * The coverage page (implementation plan 9.4, exit check 6.5): for each action of each channel,
 * whether the fake has it, how it works live, and when the differential run last saw the fake and
 * the platform agree on it. Generated from the spec's capabilities (`x-channelstack-live`), the
 * divergences, and the nightly run's results.
 */
import type { ConformanceResults, Divergence, ScenarioResult } from "./lib.ts";

interface Operation {
  "x-channelstack-method"?: { on: string; name: string };
  "x-channelstack-factory"?: { on: string; name: string };
  "x-channelstack-live"?: { unsupported?: string; requires?: string; reason?: string };
  "x-channelstack-stability"?: string;
}

/** What the page is made from. */
export interface CoverageInput {
  spec: { paths: Record<string, Record<string, Operation>> };
  divergences: readonly Divergence[];
  /** The latest differential run, if there is one. */
  results?: ConformanceResults;
  /** Each scenario's name and the actions it covers (`SlackUser.say`), so a result reaches them. */
  scenarios: ReadonlyArray<{ name: string; channel: string; covers: readonly string[] }>;
}

export interface CoverageRow {
  channel: string;
  /** `SlackUser.say`. */
  action: string;
  live: string;
  /** When the differential run last saw fake and live agree on it, or why not. */
  agreed: string;
}

const CHANNELS = ["slack", "github", "linear", "notion"];

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const liveOf = (operation: Operation): string => {
  const live = operation["x-channelstack-live"];
  if (!live) return "Works";
  if (live.unsupported !== undefined) return `Fake only: ${live.unsupported}`;
  const requires =
    live.requires === "browser" ? "the browser actor" : live.requires === "proxy" ? "proxy mode" : live.requires;
  return `Needs ${requires}${live.reason ? `: ${live.reason}` : ""}`;
};

const agreed = (result: ScenarioResult | undefined, at: string | undefined): string => {
  if (!result || !at) return "Not covered by a scenario";
  if (result.live === "skipped") return `Not run live (${result.scenario})`;
  if (result.live === "failed" || result.fake === "failed") return `Failed on ${at.slice(0, 10)} (${result.scenario})`;
  const open = result.differences.filter((difference) => !difference.allowedBy).length;
  if (open > 0) return `Differed on ${at.slice(0, 10)} (${result.scenario})`;
  const allowed = result.differences.length;
  return `Agreed on ${at.slice(0, 10)} (${result.scenario}${allowed > 0 ? `, ${allowed} known divergence${allowed === 1 ? "" : "s"}` : ""})`;
};

/** Every action of every channel, as the page lists them. */
export function coverageRows(input: CoverageInput): CoverageRow[] {
  const rows: CoverageRow[] = [];
  // A scenario can only cover an action the spec has: a name that isn't there is a typo, not coverage.
  const actions = new Set(
    Object.values(input.spec.paths).flatMap((operations) =>
      Object.values(operations).flatMap((operation) => {
        const method = operation["x-channelstack-method"] ?? operation["x-channelstack-factory"];
        return method ? [`${method.on}.${method.name}`] : [];
      }),
    ),
  );
  for (const scenario of input.scenarios) {
    const unknown = scenario.covers.filter((action) => !actions.has(action));
    if (unknown.length > 0)
      throw new Error(`${scenario.name} covers ${unknown.join(", ")}, which the spec doesn't have`);
  }
  for (const [path, operations] of Object.entries(input.spec.paths)) {
    const channel = CHANNELS.find((name) => path.includes(`/${name}`));
    if (!channel) continue;
    for (const operation of Object.values(operations)) {
      const method = operation["x-channelstack-method"] ?? operation["x-channelstack-factory"];
      if (!method) continue;
      const action = `${method.on}.${method.name}`;
      const scenario = input.scenarios.find((candidate) => candidate.covers.includes(action));
      const result = input.results?.scenarios.find((candidate) => candidate.scenario === scenario?.name);
      rows.push({
        channel,
        action,
        live: liveOf(operation),
        agreed: agreed(result, input.results?.at),
      });
    }
  }
  return rows.sort(
    (a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || a.action.localeCompare(b.action),
  );
}

/** The page in a few lines of Markdown, for a CI job's summary: per channel, its actions and how many work live and agreed. */
export function coverageSummary(input: CoverageInput): string {
  const rows = coverageRows(input);
  const lines = [
    "## channelstack coverage",
    "",
    input.results
      ? `The differential run ended ${input.results.at}${input.results.live ? "" : " (against the fakes only)"}.`
      : "No differential run's results in this build: the nightly job adds them.",
    "",
    "| Channel | Actions | Live as they are | Agreed with the platform |",
    "|---|---|---|---|",
    ...CHANNELS.map((channel) => {
      const mine = rows.filter((row) => row.channel === channel);
      const live = mine.filter((row) => row.live === "Works").length;
      const agreedLive = mine.filter((row) => row.agreed.startsWith("Agreed")).length;
      return `| ${channel} | ${mine.length} | ${live} | ${agreedLive} |`;
    }),
    "",
    `Known divergences: ${input.divergences.length}. The whole page is the \`coverage\` artifact.`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The page: a self-contained HTML document, every value escaped. */
export function coveragePage(input: CoverageInput): string {
  const rows = coverageRows(input);
  const nightly = input.results
    ? `The latest differential run ended ${escapeHtml(input.results.at)}${input.results.live ? "" : ", against the fakes only"}.`
    : "No differential run's results were given to this build.";
  const sections = CHANNELS.map((channel) => {
    const mine = rows.filter((row) => row.channel === channel);
    const works = mine.filter((row) => row.live === "Works").length;
    const body = mine
      .map(
        (row) =>
          `<tr><td><code>${escapeHtml(row.action)}</code></td><td>Yes</td><td>${escapeHtml(row.live)}</td><td>${escapeHtml(row.agreed)}</td></tr>`,
      )
      .join("\n");
    return `<section><h2>${escapeHtml(channel[0]?.toUpperCase() + channel.slice(1))}</h2>
<p>${mine.length} actions: all in the fake, ${works} live as they are.</p>
<table><thead><tr><th>Action</th><th>Fake</th><th>Live</th><th>Fake and live agree</th></tr></thead>
<tbody>
${body}
</tbody></table></section>`;
  }).join("\n");
  const divergences =
    input.divergences.length === 0
      ? "<p>None: every difference the differential run finds fails it, and is fixed in the fake.</p>"
      : `<table><thead><tr><th>Scenario</th><th>Where</th><th>Why</th><th>Expires</th></tr></thead><tbody>
${input.divergences
  .map(
    (divergence) =>
      `<tr><td>${escapeHtml(divergence.scenario)}</td><td><code>${escapeHtml(typeof divergence.path === "string" ? divergence.path : divergence.path.join(", "))}</code></td><td>${escapeHtml(divergence.reason)}</td><td>${escapeHtml(divergence.expires)}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>channelstack coverage</title>
<style>
:root { color-scheme: light dark; --line: #d0d7de; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
th, td { border-bottom: 1px solid var(--line); padding: .35rem .5rem; text-align: left; vertical-align: top; }
code { font-size: 90%; }
</style>
</head>
<body>
<h1>channelstack coverage</h1>
<p>How each channel's fake matches the real platform: whether an action works in the fake, how it works live, and when the differential run last saw both agree. ${nightly}</p>
${sections}
<section><h2>Known divergences</h2>
${divergences}
</section>
</body>
</html>
`;
}
