import type { RouteRecord } from "vite-react-ssg";

import { type DocModule, slugOf } from "./lib/docs";
import Home from "./pages/Home";
import { Root } from "./pages/Root";

const docLoaders = import.meta.glob<DocModule>(["../docs/**/*.{md,mdx}", "!**/README.md"]);

export const routes: RouteRecord[] = [
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <Home /> },
      {
        path: "docs",
        lazy: () => import("./pages/DocsLayout"),
        children: Object.entries(docLoaders).map(([file, load]) => {
          const slug = slugOf(file);
          const lazy = async () => {
            const [{ DocPage }, mod] = await Promise.all([import("./pages/DocsLayout"), load()]);
            return { element: <DocPage slug={slug} mod={mod} /> };
          };
          return slug ? { path: slug, lazy } : { index: true as const, lazy };
        }),
      },
      { path: "404", lazy: () => import("./pages/NotFound") },
      { path: "*", lazy: () => import("./pages/NotFound") },
    ],
  },
];
