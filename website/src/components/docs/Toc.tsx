import { useEffect, useState } from "react";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/**
 * "On this page": the page's H2 and H3 sections (rehype-headings gives them ids), with the one
 * being read marked. It reads the rendered page, so it appears once the page has hydrated; the
 * layout gives it the page's path as its key, so it reads each page afresh.
 */
export function Toc() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState<string>();

  useEffect(() => {
    const elements = [...document.querySelectorAll<HTMLHeadingElement>(".prose h2[id], .prose h3[id]")];
    setHeadings(
      elements.map((element) => ({
        id: element.id,
        // Without the "#" anchor the plugin appends.
        text: (element.textContent ?? "").replace(/#$/, "").trim(),
        level: element.tagName === "H2" ? 2 : 3,
      })),
    );
    setCurrent(elements[0]?.id);
    // The section being read: the last heading above the upper third of the window.
    const observer = new IntersectionObserver(
      () => {
        const line = window.innerHeight / 3;
        const passed = elements.filter((element) => element.getBoundingClientRect().top < line);
        setCurrent((passed.at(-1) ?? elements[0])?.id);
      },
      { rootMargin: "0px 0px -66% 0px", threshold: [0, 1] },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (headings.length < 2) return null;
  return (
    <nav className="doc-toc" aria-label="On this page">
      <p className="doc-side-title">On this page</p>
      <ul>
        {headings.map((heading) => (
          <li key={heading.id} className={heading.level === 3 ? "sub" : undefined}>
            <a href={`#${heading.id}`} aria-current={heading.id === current ? "location" : undefined}>
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
