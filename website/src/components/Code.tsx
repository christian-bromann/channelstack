import { useEffect, useRef, useState } from "react";

import type { Sample } from "../../plugins/samples-plugin";
import { Check, Clipboard } from "./Icons";

/** A highlighted sample. The HTML comes from our own files at build time (see plugins/samples-plugin.ts). */
export function Code({ sample, label, plain = false }: { sample: Sample; label: string; plain?: boolean }) {
  return (
    <pre className={plain ? "code plain" : "code"} tabIndex={0} role="region" aria-label={label}>
      <code>
        {sample.lines.map((html, i) => (
          <span key={i} className="line" dangerouslySetInnerHTML={{ __html: html }} />
        ))}
      </code>
    </pre>
  );
}

/** Terminal lines: `$ ` starts a command, anything else is output. */
export function Terminal({ lines, label }: { lines: string[]; label: string }) {
  return (
    <pre className="code plain" tabIndex={0} role="region" aria-label={label}>
      <code>
        {lines.map((line, i) =>
          line.startsWith("$ ") ? (
            <span key={i} className="line">
              <span className="prompt">$ </span>
              {line.slice(2)}
            </span>
          ) : (
            <span key={i} className="line out">
              {line.startsWith("✓") ? <span className="pass">✓</span> : null}
              {line.startsWith("✓") ? line.slice(1) : line}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button type="button" className="copy" data-copied={copied} onClick={copy} aria-label={copied ? "Copied" : label}>
      <Clipboard size={16} className="clip" />
      <Check size={16} className="check" />
      <span className="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
