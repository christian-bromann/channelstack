import { Link, NavLink } from "react-router-dom";

import { SITE } from "../lib/site";
import { Moon, Sun } from "./Icons";
import { Mark } from "./Mark";

function toggleTheme() {
  const root = document.documentElement;
  const current =
    root.getAttribute("data-theme") ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

export function Nav() {
  return (
    <header className="nav">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="wrap">
        <Link className="brand" to="/" aria-label="channelstack home">
          <Mark />
          channelstack
        </Link>
        <nav aria-label="Main">
          <ul className="nav-links">
            <li>
              <NavLink to="/docs">Docs</NavLink>
            </li>
            <li className="optional">
              <a href="/#examples">Examples</a>
            </li>
            <li className="optional">
              <a href="/#quick-start">Quick start</a>
            </li>
          </ul>
        </nav>
        <div className="nav-right">
          <span className="pill">coming soon</span>
          <a className="nav-gh" href={SITE.repo}>
            GitHub
          </a>
          <button
            type="button"
            className="icon-btn theme-toggle"
            onClick={toggleTheme}
            aria-label="Switch between dark and light theme"
          >
            <Sun className="sun" />
            <Moon className="moon" />
          </button>
        </div>
      </div>
    </header>
  );
}
