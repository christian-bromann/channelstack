import mdx from "@mdx-js/rollup";
import react from "@vitejs/plugin-react";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig } from "vite";
import type {} from "vite-react-ssg";
import rehypeHighlight from "./build/rehype-highlight";
import samples from "./build/samples-plugin";

export default defineConfig({
  plugins: [
    samples(),
    { enforce: "pre", ...mdx({ remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm], rehypePlugins: [rehypeHighlight] }) },
    react(),
  ],
  build: { cssCodeSplit: false, assetsInlineLimit: 0 },
  ssgOptions: { dirStyle: "flat", script: "async", formatting: "none" },
});
