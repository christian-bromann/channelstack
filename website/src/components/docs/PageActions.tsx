import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { SITE } from "../../lib/site";
import { Check, ChevronDown, Clipboard } from "../Icons";
import { type Brand, BrandIcon, type LineIcon } from "./BrandIcons";

/** The docs' MCP server (worker/index.ts). */
const MCP_URL = `${SITE.url}/mcp`;
const MCP_NAME = "channelstack-docs";

/**
 * What an assistant is asked when a page is opened in it, the wording docs sites share. Only the
 * page's public URL goes in the link.
 */
const ask = (markdownUrl: string) => `Read from ${markdownUrl} so I can ask questions about it.`;
const useInProject = (markdownUrl: string) =>
  `Read ${markdownUrl}, a page of the channelstack docs (the rest are listed at ${SITE.url}/llms.txt), and use it to help me with this project.`;

interface Action {
  key: string;
  icon: Brand | LineIcon;
  label: string;
  hint: string;
  /** `markdown` is the page's Markdown on this host; `markdownUrl` the same on channelstack.dev. */
  href?: (page: { markdown: string; markdownUrl: string }) => string;
  copy?: string;
}

/** The page: read it, or hand it to an assistant. */
const PAGE_ACTIONS: Action[] = [
  {
    key: "markdown",
    icon: "markdown",
    label: "View as Markdown",
    hint: "This page as plain text",
    href: ({ markdown }) => markdown,
  },
  {
    key: "chatgpt",
    icon: "chatgpt",
    label: "Open in ChatGPT",
    hint: "Ask questions about this page",
    href: ({ markdownUrl }) => `https://chatgpt.com/?hints=search&q=${encodeURIComponent(ask(markdownUrl))}`,
  },
  {
    key: "claude",
    icon: "claude",
    label: "Open in Claude",
    hint: "Ask questions about this page",
    href: ({ markdownUrl }) => `https://claude.ai/new?q=${encodeURIComponent(ask(markdownUrl))}`,
  },
  {
    key: "codex",
    icon: "codex",
    label: "Open in Codex",
    hint: "Use this page in the Codex app",
    href: ({ markdownUrl }) => `codex://new?prompt=${encodeURIComponent(useInProject(markdownUrl))}`,
  },
  {
    key: "cursor",
    icon: "cursor",
    label: "Open in Cursor",
    hint: "Use this page in your editor",
    href: ({ markdownUrl }) => `https://cursor.com/link/prompt?text=${encodeURIComponent(useInProject(markdownUrl))}`,
  },
];

/** The whole docs, searchable from an editor's agent through MCP (worker/index.ts). */
const MCP_ACTIONS: Action[] = [
  {
    key: "cursor-mcp",
    icon: "cursor",
    label: "Add to Cursor",
    hint: "Installs the docs' MCP server",
    href: () =>
      `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_NAME}&config=${encodeURIComponent(btoa(JSON.stringify({ url: MCP_URL })))}`,
  },
  {
    key: "vscode-mcp",
    icon: "editor",
    label: "Add to VS Code",
    hint: "Installs the docs' MCP server",
    href: () =>
      `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_NAME, type: "http", url: MCP_URL }))}`,
  },
  {
    key: "mcp",
    icon: "link",
    label: "Copy server URL",
    hint: MCP_URL.replace("https://", ""),
    copy: MCP_URL,
  },
];

type Copied = "page" | "mcp" | "failed" | null;

/**
 * "Copy page" and its menu, at the top of every docs page: the page's Markdown for an assistant,
 * the page opened in one, or the docs' MCP server added to an editor. The Markdown is what the
 * build writes next to the page (plugins/agent-docs.ts).
 */
export function PageActions({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const markdownPath = `${path}.md`;
  const markdownUrl = SITE.url + markdownPath;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        toggle.current?.focus();
      } else if (root.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (what: "page" | "mcp", text: () => Promise<string>) => {
    try {
      await navigator.clipboard.writeText(await text());
      setCopied(what);
    } catch {
      setCopied("failed");
    }
  };

  const copyPage = () =>
    copy("page", async () => {
      const response = await fetch(markdownPath);
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    });

  /** Up and down move through the menu, wrapping; Home and End jump to its ends. */
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % items.length
        : event.key === "ArrowUp"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (next === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const item = (action: Action): ReactNode => {
    const body = (
      <>
        <span className="page-action-icon">
          <BrandIcon name={action.icon} />
        </span>
        <span className="page-action-text">
          <b>{action.label}</b>
          <span>{action.key === "mcp" && copied === "mcp" ? "Copied" : action.hint}</span>
        </span>
      </>
    );
    if (action.copy) {
      const value = action.copy;
      return (
        <button
          key={action.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => copy("mcp", async () => value)}
        >
          {body}
        </button>
      );
    }
    const href = action.href?.({ markdown: markdownPath, markdownUrl });
    // Web pages open in a new tab; an app's link (codex:, cursor:, vscode:) hands over to the app.
    const web = href?.startsWith("https://") || href === markdownPath;
    return (
      <a
        key={action.key}
        role="menuitem"
        tabIndex={-1}
        href={href}
        {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={() => setOpen(false)}
      >
        {body}
      </a>
    );
  };

  return (
    <div className="page-actions" ref={root}>
      <div className="page-actions-split">
        <button type="button" className="page-actions-copy" onClick={copyPage}>
          {copied === "page" ? <Check size={15} /> : <Clipboard size={15} />}
          <span>{copied === "page" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy page"}</span>
        </button>
        <button
          ref={toggle}
          type="button"
          className="page-actions-toggle"
          aria-label="More ways to use this page"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={15} />
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied === "page" ? "Page copied as Markdown" : copied === "mcp" ? "MCP server URL copied" : ""}
      </span>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a menu of links and buttons, as WAI-ARIA's menu button pattern
        <div className="page-actions-menu" role="menu" id={menuId} aria-label="Use this page" onKeyDown={onMenuKey}>
          {PAGE_ACTIONS.map(item)}
          <p className="page-actions-group" aria-hidden="true">
            Docs MCP server
          </p>
          {MCP_ACTIONS.map(item)}
        </div>
      ) : null}
    </div>
  );
}
