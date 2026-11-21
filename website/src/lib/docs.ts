/**
 * The docs are the Markdown and MDX files in website/docs. Each file's frontmatter
 * (`title`, `order`, optional `description`) drives its route and its sidebar entry,
 * so adding a page never needs a code change.
 */
import type { ComponentType } from "react";

export interface Frontmatter {
  title: string;
  /** Position in the sidebar, ascending. Pages without it sort last, by title. */
  order?: number;
  description?: string;
}

export interface DocModule {
  default: ComponentType<{ components?: Record<string, ComponentType<any>> }>;
  frontmatter?: Frontmatter;
}

/** `../../docs/live-mode.mdx` → `live-mode`; `index` → `` (the docs landing page). */
export function slugOf(file: string): string {
  const slug = file.replace(/^.*\/docs\//, "").replace(/\.mdx?$/, "");
  return slug === "index" ? "" : slug.replace(/\/index$/, "");
}

export const docLoaders = import.meta.glob<DocModule>(["../../docs/**/*.{md,mdx}", "!**/README.md"]);

export interface DocEntry extends Frontmatter {
  slug: string;
  path: string;
}

export function toEntries(meta: Record<string, Frontmatter | undefined>): DocEntry[] {
  return Object.entries(meta)
    .map(([file, fm]) => {
      const slug = slugOf(file);
      return {
        title: fm?.title ?? (slug || "Docs"),
        order: fm?.order,
        description: fm?.description,
        slug,
        path: slug ? `/docs/${slug}` : "/docs",
      };
    })
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title));
}
