/**
 * Heading ids, the one place they're made: plugins/rehype-headings.ts gives the site's headings
 * these ids, and codegen/src/emit/docs.ts links to the generated pages' headings with them.
 * No imports, so the root workspace (which doesn't install website/) can load it by path.
 */

/** "Waiting and `quiet`!" → "waiting-and-quiet". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The ids of one page's headings, in page order. Repeat-proof: a second "Options" becomes
 * `options-1`. A heading with no letters or digits becomes `section`.
 */
export function headingIds(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}
