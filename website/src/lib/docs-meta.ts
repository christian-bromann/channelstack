/** Frontmatter of every docs page, for the sidebar and the pager. Kept apart so the home page doesn't load it. */
import { type Frontmatter, toSections } from "./docs";

export const docSections = toSections(
  import.meta.glob<Frontmatter>(["../../docs/**/*.{md,mdx}", "!**/README.md"], { eager: true, import: "frontmatter" }),
);

/** Every page in reading order: the sidebar's, top to bottom. */
export const docEntries = docSections.flatMap((section) => section.entries);
