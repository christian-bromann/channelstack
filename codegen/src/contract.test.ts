import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterAll, describe, expect, test } from "vitest";

import { checkContract } from "./contract.ts";

const dir = mkdtempSync(join(tmpdir(), "channelstack-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const options: ts.CompilerOptions = {
  strict: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts"],
  types: [],
  skipLibCheck: true,
};

/** A contract and two implementations, written to files the check reads. */
function files() {
  const contract = join(dir, "contract.d.ts");
  writeFileSync(
    contract,
    `export interface Base { readonly id: string }
export interface Widget extends Base, AsyncDisposable {
  readonly name: string;
  refresh(): Promise<Widget>;
  readonly size: number;
}
export interface Missing { readonly id: string }
export interface Options { readonly verbose?: boolean }
export interface ApiCall { readonly operation: string; readonly app: string }
export interface Fixture { readonly url: string; reset(): Promise<void> }
`,
  );
  const sdk = join(dir, "sdk.ts");
  writeFileSync(
    sdk,
    `export class Widget {
  readonly id = "w";
  readonly name = "w";
  // A property where the contract has a method, and no \`size\`, no \`[Symbol.asyncDispose]\`.
  readonly refresh = "now";
}
export interface SlackApiCall { readonly operation: string; readonly app: string }
export interface GitHubApiCall { readonly operation: string }
`,
  );
  const integration = join(dir, "integration.ts");
  writeFileSync(integration, "export interface Fixture { readonly url: string; reset(): Promise<void> }\n");
  return { contract, implementations: [sdk, integration] };
}

const run = (known: Record<string, string> = {}) =>
  checkContract({
    ...files(),
    notImplemented: new Set(["Base", "Options"]),
    perChannel: { ApiCall: ["Slack", "GitHub"] },
    known,
    options,
  });

describe("the contract against what implements it (#11)", () => {
  test("finds every kind of gap, in any implementation", () => {
    expect(run().gaps.sort()).toEqual(
      [
        // A member that is missing, a symbol-keyed one too, and a method where it is a property.
        "Widget.size",
        "Widget.[Symbol.asyncDispose]",
        "Widget.refresh (method vs property)",
        // A type nothing implements; `Base` and `Options` are declared not to be.
        "Missing",
        // A value type per channel: GitHub's lacks `app`, Slack's has it.
        "GitHubApiCall.app",
        // `Fixture` is implemented by the second module, in full: no gap.
      ].sort(),
    );
  });

  test("a gap passes only when it is listed, and a listed gap that is gone fails", () => {
    const listed = run({
      "Widget.size": "#1",
      "Widget.[Symbol.asyncDispose]": "#1",
      "Widget.refresh (method vs property)": "#1",
      Missing: "#2",
      // Not a gap: `Widget` has `name`.
      "Widget.name": "#3",
    });
    expect(listed.untracked).toEqual(["GitHubApiCall.app"]);
    expect(listed.closed).toEqual(["Widget.name"]);
  });
});
