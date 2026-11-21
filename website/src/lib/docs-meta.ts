/** Frontmatter of every docs page, for the sidebar. Kept apart so the home page doesn't load it. */
import { type Frontmatter, toEntries } from "./docs";

export const docEntries = toEntries(
  import.meta.glob<Frontmatter>(["../../docs/**/*.{md,mdx}", "!**/README.md"], { eager: true, import: "frontmatter" }),
);
