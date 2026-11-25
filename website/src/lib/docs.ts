/**
 * The docs are the Markdown and MDX files in website/docs. A page's folder is its section in the
 * sidebar, and its frontmatter (`title`, `order`, optional `description`) its place and label
 * there, so adding a page never needs a code change. website/docs/README.md is the plan.
 *
 * The sections belong to two areas, the Guide and the Reference, each with its own sidebar.
 * Nothing here is Vite-only: plugins/agent-docs.ts uses it at build time, in Node.
 */
import type { ComponentType } from "react";

export interface Frontmatter {
  title: string;
  /** Position within its section, ascending. Pages without it sort last, by title. */
  order?: number;
  description?: string;
  /** A section other than the folder's: the Reference's pages say `Tools`, `Platform APIs` or `Test API`. */
  section?: string;
}

export interface DocModule {
  default: ComponentType<{ components?: Record<string, ComponentType<any>> }>;
  frontmatter?: Frontmatter;
}

export type DocArea = "guide" | "reference";

/** The areas, as the top navigation names them: each one's sidebar holds its own sections. */
export const AREAS: ReadonlyArray<{ area: DocArea; title: string; path: string }> = [
  { area: "guide", title: "Guide", path: "/docs" },
  { area: "reference", title: "Reference", path: "/docs/reference" },
];

/** The area a path is in: the Reference's pages are all under /docs/reference. Nothing outside /docs. */
export function areaOfPath(pathname: string): DocArea | undefined {
  if (pathname.startsWith("/docs/reference")) return "reference";
  return pathname.startsWith("/docs") ? "guide" : undefined;
}

/**
 * The sidebar's sections, in order. A page is in its folder's section (`""` is website/docs
 * itself), unless its frontmatter names another of the same area.
 */
export const SECTIONS: ReadonlyArray<{ folder?: string; title: string; area: DocArea }> = [
  { folder: "", title: "Introduction", area: "guide" },
  { folder: "quickstarts", title: "Quickstarts", area: "guide" },
  { folder: "guide", title: "Guide", area: "guide" },
  { folder: "platforms", title: "Platforms", area: "guide" },
  { folder: "reference", title: "Reference", area: "reference" },
  { title: "Tools", area: "reference" },
  { title: "Platform APIs", area: "reference" },
  { title: "Test API", area: "reference" },
];

/** `../../docs/guide/live-mode.mdx` → `guide/live-mode`; `index` → `` (the docs landing page). */
export function slugOf(file: string): string {
  const slug = file.replace(/^.*\/docs\//, "").replace(/\.mdx?$/, "");
  return slug === "index" ? "" : slug.replace(/\/index$/, "");
}

/** The page's file as it is in the repository: for "Edit this page". */
export function sourceOf(file: string): string {
  return `website/docs/${file.replace(/^.*\/docs\//, "")}`;
}

export interface DocEntry extends Frontmatter {
  slug: string;
  path: string;
  section: string;
  area: DocArea;
  source: string;
}

export interface DocSection {
  title: string;
  area: DocArea;
  entries: DocEntry[];
}

/** `../../docs/reference/api/slack.mdx` → `reference`: the page's top folder, `""` for website/docs itself. */
const folderOf = (file: string) => {
  const path = file.replace(/^.*\/docs\//, "");
  return path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
};

/** The pages by section, in sidebar order. A page in a section that doesn't exist is a build error. */
export function toSections(meta: Record<string, Frontmatter | undefined>): DocSection[] {
  const entries = Object.entries(meta).map(([file, fm]): DocEntry => {
    const slug = slugOf(file);
    const folder = SECTIONS.find((candidate) => candidate.folder === folderOf(file));
    if (!folder) throw new Error(`${sourceOf(file)} is in no section: add its folder to SECTIONS in src/lib/docs.ts`);
    const section = fm?.section === undefined ? folder : SECTIONS.find((candidate) => candidate.title === fm.section);
    if (!section || section.area !== folder.area) {
      throw new Error(`${sourceOf(file)} names section "${fm?.section}", which isn't one of its area's in SECTIONS`);
    }
    return {
      title: fm?.title ?? (slug || "Docs"),
      order: fm?.order,
      description: fm?.description,
      slug,
      path: slug ? `/docs/${slug}` : "/docs",
      section: section.title,
      area: section.area,
      source: sourceOf(file),
    };
  });
  return SECTIONS.map(({ title, area }) => ({
    title,
    area,
    entries: entries
      .filter((entry) => entry.section === title)
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title)),
  })).filter((section) => section.entries.length > 0);
}
