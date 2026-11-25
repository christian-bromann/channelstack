import { useLayoutEffect } from "react";
import { Outlet, ScrollRestoration, useLocation } from "react-router-dom";

/**
 * The router's scrolling to another page (`<ScrollRestoration />`) is instant: the page's smooth
 * scrolling is for links within a page, so it's off while the page changes (`.page-change` in
 * base.css). Rendered just before `<ScrollRestoration />`, so its layout effect runs first.
 */
function PageChange() {
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs for each page, which `pathname` names
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("page-change");
    // Apply it now: the browser may otherwise scroll with the style it had before the class.
    getComputedStyle(root).scrollBehavior;
    const frame = requestAnimationFrame(() => root.classList.remove("page-change"));
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove("page-change");
    };
  }, [pathname]);
  return null;
}

/**
 * Every page's parent: the landing page, the docs and the 404 page. A link opens a page at its
 * top, or at the section it names; Back, Forward and a reload return to where the reader was.
 * Once, here, so a link between the landing page and the docs behaves like one within the docs.
 */
export function Root() {
  return (
    <>
      <PageChange />
      <ScrollRestoration />
      <Outlet />
    </>
  );
}
