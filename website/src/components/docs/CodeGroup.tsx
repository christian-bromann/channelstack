import { Children, isValidElement, type ReactElement, type ReactNode, useId, useState } from "react";

type Block = ReactElement<{ "data-title"?: string; children?: ReactNode }>;

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
 * Before the page hydrates, the first tab shows and the others are hidden.
 */
export function CodeGroup({ children }: { children: ReactNode }) {
  const blocks = Children.toArray(children).filter(isValidElement) as Block[];
  const [active, setActive] = useState(0);
  const id = useId();
  const label = (block: Block, index: number) => block.props["data-title"] ?? `Example ${index + 1}`;
  return (
    <div className="code-group">
      <div className="code-tabs" role="tablist">
        {blocks.map((block, index) => (
          <button
            key={label(block, index)}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              const next = (index + step + blocks.length) % blocks.length;
              setActive(next);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}
          >
            {label(block, index)}
          </button>
        ))}
      </div>
      {blocks.map((block, index) => (
        <div
          key={label(block, index)}
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
