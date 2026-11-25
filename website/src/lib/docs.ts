/**
 * The docs are the Markdown and MDX files in website/docs. A page's folder is its section in the
 * sidebar, and its frontmatter (`title`, `order`, optional `description`) its place and label
 * there, so adding a page never needs a code change. website/docs/README.md is the plan.
 */
import type { ComponentType } from "react";

export interface Frontmatter {
  title: string;
  /** Position within its section, ascending. Pages without it sort last, by title. */
  order?: number;
  description?: string;
}

export interface DocModule {
  default: ComponentType<{ components?: Record<string, ComponentType<any>> }>;
  frontmatter?: Frontmatter;
}

/** The sidebar's sections, in order: a folder of website/docs each (`""` is the folder itself). */
export const SECTIONS = [
  { folder: "", title: "Introduction" },
  { folder: "quickstarts", title: "Quickstarts" },
  { folder: "guide", title: "Guide" },
  { folder: "platforms", title: "Platforms" },
  { folder: "reference", title: "Reference" },
] as const;

/** `../../docs/guide/live-mode.mdx` → `guide/live-mode`; `index` → `` (the docs landing page). */
export function slugOf(file: string): string {
  const slug = file.replace(/^.*\/docs\//, "").replace(/\.mdx?$/, "");
  return slug === "index" ? "" : slug.replace(/\/index$/, "");
}

/** The page's file as it is in the repository: for "Edit this page". */
export function sourceOf(file: string): string {
  return `website/docs/${file.replace(/^.*\/docs\//, "")}`;
}

export const docLoaders = import.meta.glob<DocModule>(["../../docs/**/*.{md,mdx}", "!**/README.md"]);

export interface DocEntry extends Frontmatter {
  slug: string;
  path: string;
  section: string;
  source: string;
}

export interface DocSection {
  title: string;
  entries: DocEntry[];
}

const folderOf = (slug: string) => (slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "");

/** The pages by section, in sidebar order. A page in a folder that isn't a section is a build error. */
export function toSections(meta: Record<string, Frontmatter | undefined>): DocSection[] {
  const entries = Object.entries(meta).map(([file, fm]): DocEntry => {
    const slug = slugOf(file);
    const section = SECTIONS.find((candidate) => candidate.folder === folderOf(slug));
    if (!section) throw new Error(`${sourceOf(file)} is in no section: add its folder to SECTIONS in src/lib/docs.ts`);
    return {
      title: fm?.title ?? (slug || "Docs"),
      order: fm?.order,
      description: fm?.description,
      slug,
      path: slug ? `/docs/${slug}` : "/docs",
      section: section.title,
      source: sourceOf(file),
    };
  });
  return SECTIONS.map(({ title }) => ({
    title,
    entries: entries
      .filter((entry) => entry.section === title)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title)),
  })).filter((section) => section.entries.length > 0);
}
