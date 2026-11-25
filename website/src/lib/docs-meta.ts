/** Frontmatter of every docs page, for the sidebar and the pager. Kept apart so the home page doesn't load it. */
import { type DocArea, type Frontmatter, toSections } from "./docs";

export const docSections = toSections(
  import.meta.glob<Frontmatter>(["../../docs/**/*.{md,mdx}", "!**/README.md"], { eager: true, import: "frontmatter" }),
);

/** Every page in reading order: the sidebar's, top to bottom, the Guide's before the Reference's. */
export const docEntries = docSections.flatMap((section) => section.entries);

/** The sections and pages of one area: what its sidebar shows and its pager steps through. */
export const sectionsOf = (area: DocArea) => docSections.filter((section) => section.area === area);
export const entriesOf = (area: DocArea) => docEntries.filter((entry) => entry.area === area);
