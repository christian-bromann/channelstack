import { useState } from "react";
import { Link } from "react-router-dom";
import { SITE } from "../lib/site";
import { Pause, Play } from "./Icons";
import { Mark } from "./Mark";

const DOCS = [
  ["Getting started", "/docs/getting-started"],
  ["Slack", "/docs/slack"],
  ["GitHub", "/docs/github"],
  ["Linear", "/docs/linear"],
  ["Notion", "/docs/notion"],
  ["Live mode", "/docs/live-mode"],
  ["API reference", "/docs/api-reference"],
] as const;

export function Footer() {
  const [paused, setPaused] = useState(false);

  // Pauses the looping decorations. CSS animations follow `data-motion` (base.css); the
  // script-driven waveforms listen for the "motionchange" event.
  function toggleMotion() {
    const next = !paused;
    setPaused(next);
    if (next) document.documentElement.setAttribute("data-motion", "paused");
    else document.documentElement.removeAttribute("data-motion");
    document.dispatchEvent(new Event("motionchange"));
  }

  return (
    <footer className="footer">
      <div className="wrap">
        <div className="about">
          <Link className="brand" to="/">
            <Mark />
            channelstack
          </Link>
          <p className="legal">
            MIT licensed. channelstack is an independent project, not affiliated with or endorsed by Slack, GitHub, Linear or Notion. Their names and logos are trademarks of their owners.
          </p>
          <button type="button" className="motion-toggle" onClick={toggleMotion}>
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? "Play animations" : "Pause animations"}
          </button>
        </div>
        <nav aria-labelledby="footer-docs">
          <h2 id="footer-docs">Docs</h2>
          <ul>
            {DOCS.map(([label, to]) => (
              <li key={to}>
                <Link to={to}>{label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-labelledby="footer-project">
          <h2 id="footer-project">Project</h2>
          <ul>
            <li>
              <a href={SITE.repo}>GitHub</a>
            </li>
            <li>
              <a href="/#why">Why channelstack</a>
            </li>
            <li>
              <a href="/#quick-start">Quick start</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
