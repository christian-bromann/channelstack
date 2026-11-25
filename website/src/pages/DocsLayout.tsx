import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { CodeGroup } from "../components/docs/CodeGroup";
import {
  FakeOrLive,
  ProxyRouting,
  QuietWindow,
  RequestFlow,
  RetryTimeline,
  SessionScopes,
  TerminalSession,
} from "../components/docs/Figures";
import { Toc } from "../components/docs/Toc";
import { Footer } from "../components/Footer";
import { ArrowRight } from "../components/Icons";
import { Nav } from "../components/Nav";
import { Seo } from "../components/Seo";
import { areaOfPath, type DocArea, type DocModule } from "../lib/docs";
import { docEntries, entriesOf, sectionsOf } from "../lib/docs-meta";
import { SITE } from "../lib/site";

/** What every page can use without importing it (website/docs/README.md lists them). */
const MDX_COMPONENTS = {
  CodeGroup,
  FakeOrLive,
  ProxyRouting,
  QuietWindow,
  RequestFlow,
  RetryTimeline,
  SessionScopes,
  TerminalSession,
};

/** The sidebar of one area: the Guide's or the Reference's sections, never both. */
function Sidebar({ area }: { area: DocArea }) {
  return (
    <div className="doc-sections">
      {sectionsOf(area).map((section) => (
        <section key={section.title}>
          <p className="doc-side-title">{section.title}</p>
          <ul className="doc-nav">
            {section.entries.map((entry) => (
              <li key={entry.path}>
                <NavLink to={entry.path} end>
                  {entry.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The docs shell: the sidebar by section, the page, and the page's outline. */
export function Component() {
  const { pathname } = useLocation();
  const area = areaOfPath(pathname) ?? "guide";
  return (
    <>
      <Nav />
      <div className="wrap docs">
        <details className="doc-menu">
          <summary>Docs menu</summary>
          <nav aria-label="Docs (menu)">
            <Sidebar area={area} />
          </nav>
        </details>
        <nav className="doc-side" aria-label="Docs">
          <Sidebar area={area} />
        </nav>
        <main id="main" className="doc-main">
          <Outlet />
        </main>
        <aside className="doc-aside">
          <Toc key={pathname} />
        </aside>
      </div>
      <Footer />
    </>
  );
}

export function DocPage({ slug, mod }: { slug: string; mod: DocModule }) {
  // The pager steps through the page's own area: the Guide's last page doesn't lead into the Reference.
  const area = docEntries.find((candidate) => candidate.slug === slug)?.area ?? "guide";
  const pages = entriesOf(area);
  const index = pages.findIndex((candidate) => candidate.slug === slug);
  const entry = pages[index];
  const prev = pages[index - 1];
  const next = pages[index + 1];
  const Content = mod.default;
  const title = entry?.title ?? "Docs";
  return (
    <>
      <Seo
        title={slug ? `${title} · channelstack docs` : "channelstack docs"}
        description={entry?.description}
        path={entry?.path ?? "/docs"}
      />
      {entry && entry.section !== "Introduction" ? <p className="doc-eyebrow">{entry.section}</p> : null}
      <article className="prose">
        <Content components={MDX_COMPONENTS} />
      </article>
      {entry ? (
        <p className="doc-edit">
          <a href={`${SITE.repo}/edit/main/${entry.source}`}>Suggest changes to this page</a>
        </p>
      ) : null}
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
