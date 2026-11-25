import { Children, isValidElement, type ReactElement, type ReactNode, useId, useSyncExternalStore } from "react";

type Block = ReactElement<{ "data-title"?: string; children?: ReactNode }>;

/**
 * The tab a reader picked last, by its label ("Python", "Rust"). Every group on every page shows
 * that tab when it has one, so a Python reader picks Python once. It's kept in localStorage; a
 * browser that refuses it just doesn't remember.
 */
const STORAGE_KEY = "channelstack.docs.tab";
const listeners = new Set<() => void>();
let picked: string | null | undefined;

function readPicked(): string | null {
  if (picked === undefined) {
    try {
      picked = localStorage.getItem(STORAGE_KEY);
    } catch {
      picked = null;
    }
  }
  return picked;
}

function pick(label: string) {
  picked = label;
  try {
    localStorage.setItem(STORAGE_KEY, label);
  } catch {
    // private mode: the choice lasts for this page only
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The same example in several languages or package managers, as tabs. Each child is a fenced
 * code block; its `title` is the tab's label:
 *
 *   <CodeGroup>
 *   ```ts title="TypeScript"
 *   ```
 *   ```python title="Python"
 *   ```
 *   </CodeGroup>
 *
 * The page is prerendered with the first tab; once it runs, the reader's last pick shows.
 */
export function CodeGroup({ children }: { children: ReactNode }) {
  const blocks = Children.toArray(children).filter(isValidElement) as Block[];
  const label = (block: Block, index: number) => block.props["data-title"] ?? `Example ${index + 1}`;
  const labels = blocks.map(label);
  const preferred = useSyncExternalStore(subscribe, readPicked, () => null);
  const active = Math.max(0, preferred === null ? 0 : labels.indexOf(preferred));
  const id = useId();
  return (
    <div className="code-group">
      <div className="code-tabs" role="tablist">
        {labels.map((name, index) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => pick(name)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              const next = (index + step + labels.length) % labels.length;
              pick(labels[next] ?? name);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {blocks.map((block, index) => (
        <div
          key={labels[index]}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== active}
        >
          {block}
        </div>
      ))}
    </div>
  );
}
