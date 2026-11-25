import type { Sample } from "../../../plugins/samples-plugin";
import { Code } from "../Code";
import { CodeGroup } from "./CodeGroup";

/**
 * One test in every SDK's language, as tabs: `<Example id="slack-mention-one-reply" />`.
 *
 * The three versions are real files in `website/examples/`, type-checked and compiled in CI:
 *   ts/slack-mention-one-reply.test.ts     (pnpm typecheck:samples, against ../api/*.d.ts)
 *   python/test_slack_mention_one_reply.py (pnpm typecheck at the root: pyright, strict)
 *   rust/src/slack_mention_one_reply.rs    (pnpm test:rust at the root: clippy)
 * Their `@show:start` … `@show:end` markers pick what the page shows (plugins/samples-plugin.ts).
 */
const LANGUAGES = [
  {
    title: "TypeScript",
    file: (id: string) => `../../../examples/ts/${id}.test.ts`,
    samples: import.meta.glob<Sample>("../../../examples/ts/*.test.ts", {
      query: "?sample",
      import: "default",
      eager: true,
    }),
  },
  {
    title: "Python",
    file: (id: string) => `../../../examples/python/test_${id.replaceAll("-", "_")}.py`,
    samples: import.meta.glob<Sample>("../../../examples/python/test_*.py", {
      query: "?sample",
      import: "default",
      eager: true,
    }),
  },
  {
    title: "Rust",
    file: (id: string) => `../../../examples/rust/src/${id.replaceAll("-", "_")}.rs`,
    samples: import.meta.glob<Sample>("../../../examples/rust/src/*.rs", {
      query: "?sample",
      import: "default",
      eager: true,
    }),
  },
];

export function Example({ id }: { id: string }) {
  const tabs = LANGUAGES.map(({ title, file, samples }) => {
    const sample = samples[file(id)];
    // Prerendering every page runs this, so a missing file fails the build.
    if (!sample) throw new Error(`<Example id="${id}" />: there is no ${file(id).replace("../../../", "website/")}`);
    return { title, sample };
  });
  return (
    <CodeGroup>
      {tabs.map(({ title, sample }) => (
        <Code key={title} data-title={title} sample={sample} label={`${title} example`} plain />
      ))}
    </CodeGroup>
  );
}
