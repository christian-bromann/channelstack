import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig } from "vite";
import type {} from "vite-react-ssg";

import rehypeHeadings from "./plugins/rehype-headings";
import rehypeHighlight from "./plugins/rehype-highlight";
import remarkCallouts from "./plugins/remark-callouts";
import samples from "./plugins/samples-plugin";

export default defineConfig({
  plugins: [
    samples(),
    {
      enforce: "pre",
      ...mdx({
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm, remarkCallouts],
        rehypePlugins: [rehypeHeadings, rehypeHighlight],
      }),
    },
    react(),
  ],
  build: { cssCodeSplit: false, assetsInlineLimit: 0 },
  // script "sync": a plain module script runs after the document is parsed, so the inline data
  // the prerenderer writes at the end of <body> is always there before the app starts.
  ssgOptions: { dirStyle: "flat", script: "sync", formatting: "none" },
});
