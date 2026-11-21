import type { RouteRecord } from "vite-react-ssg";
import { docLoaders, slugOf } from "./lib/docs";
import Home from "./pages/Home";

export const routes: RouteRecord[] = [
  { path: "/", element: <Home /> },
  {
    path: "/docs",
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
  { path: "/404", lazy: () => import("./pages/NotFound") },
  { path: "*", lazy: () => import("./pages/NotFound") },
];
