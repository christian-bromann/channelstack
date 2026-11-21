declare module "*?sample" {
  const sample: import("../plugins/samples-plugin").Sample;
  export default sample;
}

declare module "*.mdx" {
  import type { ComponentType } from "react";
  export const frontmatter: import("./lib/docs").Frontmatter;
  const Content: ComponentType<{ components?: Record<string, ComponentType<any>> }>;
  export default Content;
}

declare module "*.md" {
  export * from "*.mdx";
  export { default } from "*.mdx";
}
