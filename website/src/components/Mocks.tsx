import type { ReactNode } from "react";

/**
 * What each example's test produces, drawn to look like the platform it runs on: a Slack
 * conversation, a GitHub issue, a Linear issue with an agent session, a Notion page with
 * comments. Every part carries the playback step at which it appears, so the mock-up plays
 * in step with the highlighted line of the test.
 */

export interface MockProps {
  /** Current playback step. Parts with a higher step are still hidden. */
  step: number;
}

const when = (step: number, at: number, base: string) => (step >= at ? base : `${base} is-pending`);

const Mention = ({ children }: { children: string }) => <span className="mention">{children}</span>;

// ---------------------------------------------------------------------------
// Slack

function SlackMessage({ who, bot = false, time, className, children }: { who: string; bot?: boolean; time: string; className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <span className={bot ? "sl-avatar bot" : "sl-avatar"} aria-hidden="true">
        {who[0]!.toUpperCase()}
      </span>
      <div>
        <p className="sl-who">
          <b>{who}</b> {bot ? <span className="sl-app">APP</span> : null} <small>{time}</small>
        </p>
        {children}
      </div>
    </div>
  );
}

function SlackShell({ title, composer, children }: { title: ReactNode; composer: string; children: ReactNode }) {
  return (
    <div className="app app-slack">
      <div className="sl-head">{title}</div>
      <div className="sl-body">{children}</div>
      <div className="sl-composer" aria-hidden="true">
        <span>{composer}</span>
        <i />
      </div>
    </div>
  );
}

/** The hero test: a DM that asks for approval before deploying. */
export function SlackMock({ step }: MockProps) {
  return (
    <SlackShell
      composer="Message robin"
      title={
        <>
          <span className="sl-avatar bot small" aria-hidden="true">R</span>
          <b>robin</b>
          <span className="sl-app">APP</span>
        </>
      }
    >
      <SlackMessage who="ana" time="10:42 AM" className={when(step, 1, "sl-msg")}>
        <p>
          <Mention>@robin</Mention> ship #812 to staging
        </p>
      </SlackMessage>
      <div className="slot">
        <p className={step === 2 ? "sl-status" : "sl-status is-pending"} aria-hidden={step !== 2}>
          <b>robin</b> is checking CI on #812…
        </p>
        <SlackMessage who="robin" bot time="10:42 AM" className={when(step, 3, "sl-msg")}>
          <p>Deploy #812 to staging? CI passed 4 minutes ago, 2 files changed.</p>
          <p className="sl-actions">
            <span className={step >= 4 ? "sl-btn primary is-clicked" : "sl-btn primary"}>Approve</span>
            <span className="sl-btn">Cancel</span>
          </p>
        </SlackMessage>
      </div>
      <SlackMessage who="robin" bot time="10:43 AM" className={when(step, 5, "sl-msg")}>
        <p>Deployed #812 to staging in 41s. ana approved it.</p>
      </SlackMessage>
    </SlackShell>
  );
}

// ---------------------------------------------------------------------------
// GitHub

function GitHubComment({ who, bot = false, className, children }: { who: string; bot?: boolean; className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <span className={bot ? "gh-avatar bot" : "gh-avatar"} aria-hidden="true">
        {who[0]!.toUpperCase()}
      </span>
      <div className="gh-box">
        <p className="gh-box-head">
          <b>{who}</b>
          {bot ? <span className="gh-label">bot</span> : null} commented now
        </p>
        <div className="gh-box-body">{children}</div>
      </div>
    </div>
  );
}

export function GitHubMock({ step }: MockProps) {
  return (
    <div className="app app-github">
      <div className="gh-top">
        <span>acme</span> / <b>web</b>
        <span className="gh-tab">Issues</span>
      </div>
      <div className="gh-body">
        <div className={when(step, 1, "gh-issue")}>
          <p className="app-title">
            Login 500s on Safari <span>#1</span>
          </p>
          <p className="gh-meta">
            <span className="gh-state">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="8" cy="8" r="2" fill="currentColor" />
              </svg>
              Open
            </span>
            <span>
              <b>mo</b> opened this issue now
            </span>
          </p>
        </div>
        <div className="gh-timeline">
          <GitHubComment who="mo" className={when(step, 2, "gh-comment")}>
            <p>
              <Mention>@robin</Mention> can you take a look?
            </p>
          </GitHubComment>
          <GitHubComment who="robin" bot className={when(step, 3, "gh-comment")}>
            <p>Reproduced on Safari 17: the session cookie is dropped on the redirect. A fix is on the way.</p>
          </GitHubComment>
          <p className={when(step, 4, "gh-event")}>
            <i aria-hidden="true" />
            <span>
              <b>issue_comment</b> redelivered with the same GUID
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linear

export function LinearMock({ step }: MockProps) {
  return (
    <div className="app app-linear">
      <div className="ln-top">
        <span className="ln-team" aria-hidden="true" />
        Engineering <span className="ln-sep">›</span> <b>ENG-1</b>
      </div>
      <div className="ln-body">
        <div className={when(step, 1, "ln-issue")}>
          <p className="app-title">Migrate billing cron</p>
          <p className="ln-props">
            <span>
              <i className="ln-status" aria-hidden="true" />
              In Progress
            </span>
            <span>
              <i className="ln-avatar" aria-hidden="true">K</i>
              Kai
            </span>
            <span className={when(step, 2, "ln-delegate")}>
              <i className="ln-avatar bot" aria-hidden="true">R</i>
              robin
            </span>
          </p>
        </div>
        <p className={when(step, 1, "ln-label")}>Activity</p>
        <ul className="ln-activity">
          <li className={when(step, 1, "ln-row")}>
            <i className="ln-avatar" aria-hidden="true">K</i>
            <span>
              <b>Kai</b> created the issue
            </span>
          </li>
          <li className={when(step, 2, "ln-row")}>
            <i className="ln-avatar" aria-hidden="true">K</i>
            <span>
              <b>Kai</b> delegated the issue to <b>robin</b>
            </span>
          </li>
          <li className={when(step, 2, "ln-session")}>
            <p className="ln-session-head">
              <i className="ln-avatar bot" aria-hidden="true">R</i>
              <b>robin</b>
              <span className="ln-agent">Agent</span>
              <span className="spacer" />
              <span className={step >= 5 ? "ln-state done" : "ln-state"}>{step >= 5 ? "Complete" : "Working"}</span>
            </p>
            <p className={when(step, 3, "ln-thought")}>Reading the cron definitions in billing/cron.ts…</p>
            <p className={when(step, 4, "ln-stopped")}>
              <i aria-hidden="true" />
              Kai stopped the session
            </p>
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notion

function NotionComment({ who, bot = false, className, children }: { who: string; bot?: boolean; className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <span className={bot ? "nt-avatar bot" : "nt-avatar"} aria-hidden="true">
        {who[0]!.toUpperCase()}
      </span>
      <div>
        <p className="nt-who">
          <b>{who}</b> <small>Just now</small>
        </p>
        {children}
      </div>
    </div>
  );
}

export function NotionMock({ step }: MockProps) {
  return (
    <div className="app app-notion">
      <div className="nt-top">
        <span className={when(step, 1, "nt-crumb")}>Roadmap</span>
        <span className="spacer" />
        <span>Share</span>
        <span aria-hidden="true">···</span>
      </div>
      <div className="nt-body">
        <div className={when(step, 1, "nt-doc")}>
          <p className="app-title">Roadmap</p>
          <p className="nt-h1">Q1</p>
          <ul>
            <li>ship search</li>
          </ul>
        </div>
        <div className="nt-comments">
          <NotionComment who="Ana" className={when(step, 2, "nt-comment")}>
            <p>
              <Mention>@robin</Mention> summarize this page
            </p>
          </NotionComment>
          <NotionComment who="robin" bot className={when(step, 3, "nt-comment")}>
            <p>Q1 has one goal: ship search.</p>
          </NotionComment>
          <p className={when(step, 2, "nt-reply")} aria-hidden="true">
            Reply…
          </p>
        </div>
      </div>
    </div>
  );
}
