import { Link } from "react-router-dom";

import { SITE } from "../lib/site";
import { Mark } from "./Mark";

const DOCS = [
  ["Getting started", "/docs/getting-started"],
  ["Slack", "/docs/platforms/slack"],
  ["GitHub", "/docs/platforms/github"],
  ["Linear", "/docs/platforms/linear"],
  ["Notion", "/docs/platforms/notion"],
  ["Resend", "/docs/platforms/resend"],
  ["Google", "/docs/platforms/google"],
  ["Discord", "/docs/platforms/discord"],
  ["Live mode", "/docs/guide/live-mode"],
  ["Reference", "/docs/reference"],
] as const;

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="about">
          <Link className="brand" to="/">
            <Mark />
            channelstack
          </Link>
          <p className="legal">
            MIT licensed. channelstack is an independent project, not affiliated with or endorsed by Slack, GitHub,
            Linear, Notion, Resend, Google or Discord. All names and logos shown, including TypeScript, Python and Rust,
            are trademarks of their owners. The docs' assistant and editor icons are from{" "}
            <a href="https://github.com/lobehub/lobe-icons">Lobe Icons</a> (MIT) and Microsoft's{" "}
            <a href="https://github.com/microsoft/vscode-codicons">Codicons</a> (
            <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>).
          </p>
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
