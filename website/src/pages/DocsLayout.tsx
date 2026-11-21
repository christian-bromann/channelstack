import { Link, NavLink, Outlet } from "react-router-dom";
import { Footer } from "../components/Footer";
import { ArrowRight } from "../components/Icons";
import { Nav } from "../components/Nav";
import { Seo } from "../components/Seo";
import type { DocModule } from "../lib/docs";
import { docEntries } from "../lib/docs-meta";

function Sidebar() {
  return (
    <ul className="doc-nav">
      {docEntries.map((entry) => (
        <li key={entry.path}>
          <NavLink to={entry.path} end>
            {entry.title}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** The docs shell: sidebar generated from the pages' frontmatter, page content in the outlet. */
export function Component() {
  return (
    <>
      <Nav />
      <div className="wrap docs">
        <details className="doc-menu">
          <summary>Docs menu</summary>
          <nav aria-label="Docs (menu)">
            <Sidebar />
          </nav>
        </details>
        <nav className="doc-side" aria-label="Docs">
          <p className="doc-side-title">Documentation</p>
          <Sidebar />
        </nav>
        <main id="main" className="doc-main">
          <Outlet />
        </main>
      </div>
      <Footer />
    </>
  );
}

export function DocPage({ slug, mod }: { slug: string; mod: DocModule }) {
  const index = docEntries.findIndex((entry) => entry.slug === slug);
  const entry = docEntries[index];
  const prev = docEntries[index - 1];
  const next = docEntries[index + 1];
  const Content = mod.default;
  const title = entry?.title ?? "Docs";
  return (
    <>
      <Seo title={slug ? `${title} · channelstack docs` : "channelstack docs"} description={entry?.description} path={entry?.path ?? "/docs"} />
      <article className="prose">
        <Content />
      </article>
      <nav className="doc-pager" aria-label="Previous and next page">
        {prev ? (
          <Link className="prev" to={prev.path}>
            <span>Previous</span>
            {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link className="next" to={next.path}>
            <span>Next</span>
            {next.title}
            <ArrowRight size={15} />
          </Link>
        ) : null}
      </nav>
    </>
  );
}
