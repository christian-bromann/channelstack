import type { ReactNode } from "react";

/**
 * What each example's test produces, drawn to look like the platform it runs on: a Slack
 * conversation, a GitHub issue, a Linear issue with an agent session, a Notion page with
 * comments, an email thread, a Discord channel, and a Slack thread with the model calls the fake
 * OpenAI recorded. Every part carries the playback step at which it appears, so the mock-up plays
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

function SlackMessage({
  who,
  bot = false,
  time,
  className,
  children,
}: {
  who: string;
  bot?: boolean;
  time: string;
  className: string;
  children: ReactNode;
}) {
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
      composer="Message my-agent"
      title={
        <>
          <span className="sl-avatar bot small" aria-hidden="true">
            R
          </span>
          <b>my-agent</b>
          <span className="sl-app">APP</span>
        </>
      }
    >
      <SlackMessage who="ana" time="10:42 AM" className={when(step, 1, "sl-msg")}>
        <p>
          <Mention>@my-agent</Mention> ship #812 to staging
        </p>
      </SlackMessage>
      <div className="slot">
        <p className={step === 2 ? "sl-status" : "sl-status is-pending"} aria-hidden={step !== 2}>
          <b>my-agent</b> is checking CI on #812…
        </p>
        <SlackMessage who="my-agent" bot time="10:42 AM" className={when(step, 3, "sl-msg")}>
          <p>Deploy #812 to staging? CI passed 4 minutes ago, 2 files changed.</p>
          <p className="sl-actions">
            <span className={step >= 4 ? "sl-btn primary is-clicked" : "sl-btn primary"}>Approve</span>
            <span className="sl-btn">Cancel</span>
          </p>
        </SlackMessage>
      </div>
      <SlackMessage who="my-agent" bot time="10:43 AM" className={when(step, 5, "sl-msg")}>
        <p>Deployed #812 to staging in 41s. ana approved it.</p>
      </SlackMessage>
    </SlackShell>
  );
}

// ---------------------------------------------------------------------------
// GitHub

function GitHubComment({
  who,
  bot = false,
  className,
  children,
}: {
  who: string;
  bot?: boolean;
  className: string;
  children: ReactNode;
}) {
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
            500s on Safari <span>#1</span>
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
              <Mention>@my-agent</Mention> take a look?
            </p>
          </GitHubComment>
          <GitHubComment who="my-agent" bot className={when(step, 3, "gh-comment")}>
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
          <p className="app-title">Migrate cron</p>
          <p className="ln-props">
            <span>
              <i className="ln-status" aria-hidden="true" />
              In Progress
            </span>
            <span>
              <i className="ln-avatar" aria-hidden="true">
                K
              </i>
              Kai
            </span>
            <span className={when(step, 2, "ln-delegate")}>
              <i className="ln-avatar bot" aria-hidden="true">
                R
              </i>
              my-agent
            </span>
          </p>
        </div>
        <p className={when(step, 1, "ln-label")}>Activity</p>
        <ul className="ln-activity">
          <li className={when(step, 1, "ln-row")}>
            <i className="ln-avatar" aria-hidden="true">
              K
            </i>
            <span>
              <b>Kai</b> created the issue
            </span>
          </li>
          <li className={when(step, 2, "ln-row")}>
            <i className="ln-avatar" aria-hidden="true">
              K
            </i>
            <span>
              <b>Kai</b> delegated the issue to <b>my-agent</b>
            </span>
          </li>
          <li className={when(step, 2, "ln-session")}>
            <p className="ln-session-head">
              <i className="ln-avatar bot" aria-hidden="true">
                R
              </i>
              <b>my-agent</b>
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

function NotionComment({
  who,
  bot = false,
  className,
  children,
}: {
  who: string;
  bot?: boolean;
  className: string;
  children: ReactNode;
}) {
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
              <Mention>@my-agent</Mention> summarize
            </p>
          </NotionComment>
          <NotionComment who="my-agent" bot className={when(step, 3, "nt-comment")}>
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

// ---------------------------------------------------------------------------
// Email (Resend, Gmail): one thread, as the person who wrote in reads it. Not a copy of any
// product's client: the same view serves both channels.

function EmailMessage({
  step,
  at,
  who,
  from,
  to,
  bot = false,
  attachment,
  children,
}: {
  step: number;
  at: number;
  who: string;
  from: string;
  to: string;
  bot?: boolean;
  attachment?: string;
  children: ReactNode;
}) {
  return (
    <div className={when(step, at, "em-msg")}>
      <span className={bot ? "em-avatar bot" : "em-avatar"} aria-hidden="true">
        {who[0]!.toUpperCase()}
      </span>
      <div>
        <p className="em-from">
          <b>{who}</b> <span>&lt;{from}&gt;</span>
          <small>9:14 AM</small>
        </p>
        <p className="em-to">to {to}</p>
        <div className="em-text">{children}</div>
        {attachment ? (
          <p className="em-file">
            <span aria-hidden="true">PDF</span>
            {attachment}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function EmailShell({ mailbox, children }: { mailbox: string; children: ReactNode }) {
  return (
    <div className="app app-email">
      <div className="em-top">
        <span>Inbox</span>
        <span className="spacer" />
        <span className="em-box">{mailbox}</span>
      </div>
      <div className="em-body">{children}</div>
    </div>
  );
}

export function ResendMock({ step }: MockProps) {
  return (
    <EmailShell mailbox="ana@example.com">
      <p className={when(step, 1, "em-subject")}>Refund</p>
      <EmailMessage step={step} at={1} who="Ana" from="ana@example.com" to="my-agent@acme.resend.app">
        <p>Where is my refund for #4411?</p>
      </EmailMessage>
      <EmailMessage step={step} at={2} who="my-agent" bot from="my-agent@acme.resend.app" to="ana@example.com">
        <p>Your refund for #4411 went out on Monday. It reaches your card within 5 days.</p>
      </EmailMessage>
      <p className={when(step, 3, "em-event")}>
        Resend delivered <code>email.received</code> again, with the same <code>svix-id</code>
      </p>
    </EmailShell>
  );
}

/** Gmail's line icons, drawn simply: no Google artwork. */
const GmIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const GM = {
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20",
  tune: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  back: "M19 12H5M11 6l-6 6 6 6",
  archive: "M4 6h16v4H4zM5 10v9h14v-9M10 14h4",
  spam: "M12 3l9 9-9 9-9-9zM12 8v5M12 16h0",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  more: "M12 5h0M12 12h0M12 19h0",
  star: "M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2l.9-5.5-4-3.9 5.5-.8z",
  reply: "M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1",
  forward: "M14 8l5 4-5 4M19 12h-9a5 5 0 0 0-5 5v1",
};

function GmailMessage({
  step,
  at,
  who,
  from,
  bot = false,
  attachment,
  children,
}: {
  step: number;
  at: number;
  who: string;
  from: string;
  bot?: boolean;
  attachment?: string;
  children: ReactNode;
}) {
  return (
    <div className={when(step, at, "gm-msg")}>
      <span className={bot ? "gm-avatar bot" : "gm-avatar"} aria-hidden="true">
        {who[0]!.toUpperCase()}
      </span>
      <div>
        <div className="gm-head">
          <p>
            <b>{who}</b> <span>&lt;{from}&gt;</span>
          </p>
          <small>9:14 AM</small>
          <span className="gm-icons">
            <GmIcon d={GM.star} />
            <GmIcon d={GM.reply} />
            <GmIcon d={GM.more} />
          </span>
        </div>
        <p className="gm-to">
          to me <span aria-hidden="true">▾</span>
        </p>
        <div className="gm-text">{children}</div>
        {attachment ? (
          <div className="gm-file">
            <span className="gm-file-thumb" aria-hidden="true">
              PDF
            </span>
            <span>{attachment}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GmailMock({ step }: MockProps) {
  return (
    <div className="app app-gmail">
      <div className="gm-top">
        <span className="gm-search">
          <GmIcon d={GM.search} />
          <span>Search mail</span>
          <span className="spacer" />
          <GmIcon d={GM.tune} />
        </span>
      </div>
      <div className="gm-card">
        <div className="gm-tools" aria-hidden="true">
          <GmIcon d={GM.back} />
          <GmIcon d={GM.archive} />
          <GmIcon d={GM.spam} />
          <GmIcon d={GM.trash} />
          <i />
          <GmIcon d={GM.mail} />
          <GmIcon d={GM.more} />
          <span className="spacer" />
          <small>1 of 2</small>
        </div>
        <p className={when(step, 1, "gm-subject")}>
          Invoice <span className="gm-chip">Inbox ×</span>
          <span className={when(step, 3, "gm-count")}>2 in this thread</span>
        </p>
        {step >= 2 ? (
          <div className="gm-collapsed">
            <span className="gm-avatar small" aria-hidden="true">
              A
            </span>
            <b>Ana</b>
            <span>Can you resend the March invoice?</span>
            <small>9:14 AM</small>
          </div>
        ) : (
          <GmailMessage step={step} at={1} who="Ana" from="ana@example.com">
            <p>Can you resend the March invoice?</p>
          </GmailMessage>
        )}
        <GmailMessage
          step={step}
          at={2}
          who="my-agent"
          bot
          from="my-agent@example.com"
          attachment="invoice-2026-03.pdf"
        >
          <p>Here is the March invoice again, attached.</p>
        </GmailMessage>
        <div className={when(step, 2, "gm-actions")} aria-hidden="true">
          <span>
            <GmIcon d={GM.reply} /> Reply
          </span>
          <span>
            <GmIcon d={GM.forward} /> Forward
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discord: a guild's text channel, its layout and colours, no Discord artwork.

function DiscordMessage({
  who,
  bot = false,
  time,
  className,
  quote,
  children,
}: {
  who: string;
  bot?: boolean;
  time: string;
  className: string;
  /** Discord's reply: the message it answers, quoted above it. */
  quote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {quote ? (
        <p className="dc-quote">
          <span className="dc-quote-line" aria-hidden="true" />
          {quote}
        </p>
      ) : null}
      <div className="dc-row">
        <span className={bot ? "dc-avatar bot" : "dc-avatar"} aria-hidden="true">
          {who[0]!.toUpperCase()}
        </span>
        <div>
          <p className="dc-who">
            <b>{who}</b> {bot ? <span className="dc-app">APP</span> : null} <small>{time}</small>
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}

/** A mention in a channel, answered once with Discord's reply. */
export function DiscordMock({ step }: MockProps) {
  return (
    <div className="app app-discord">
      <div className="dc-head">
        <span className="dc-hash" aria-hidden="true">
          #
        </span>
        <b>support</b>
      </div>
      <div className="dc-body">
        <DiscordMessage who="Ana" time="Today at 10:42 AM" className={when(step, 1, "dc-msg")}>
          <p>
            <Mention>@my-agent</Mention> why is the build red?
          </p>
        </DiscordMessage>
        <DiscordMessage
          who="my-agent"
          bot
          time="Today at 10:42 AM"
          className={when(step, 2, step >= 3 ? "dc-msg is-replied" : "dc-msg")}
          quote={
            <>
              <b>@Ana</b> why is the build red?
            </>
          }
        >
          <p>The lint step fails on main since 9:58: an unused import in api/routes.ts.</p>
        </DiscordMessage>
      </div>
      <div className="dc-composer" aria-hidden="true">
        <span>Message #support</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenAI: a Slack thread, and below it the calls the fake OpenAI recorded, in the site's code
// colours. No OpenAI artwork.

function ModelCall({
  step,
  at,
  dir,
  children,
}: {
  step: number;
  at: number;
  dir: "request" | "answer";
  children: ReactNode;
}) {
  return (
    <li className={when(step, at, `md-row ${dir}`)}>
      <span className="md-dir">{dir === "request" ? "agent →" : "← model"}</span>
      <span className="md-what">{children}</span>
    </li>
  );
}

/** Ana asks in a channel; the model calls a tool, gets its result, and answers once. */
export function ModelMock({ step }: MockProps) {
  return (
    <div className="app app-model">
      <div className="app-slack md-thread">
        <div className="sl-head">
          <span className="md-hash" aria-hidden="true">
            #
          </span>
          <b>ops</b>
        </div>
        <div className="sl-body">
          <SlackMessage who="ana" time="9:30 AM" className={when(step, 1, "sl-msg")}>
            <p>
              <Mention>@my-agent</Mention> what broke yesterday?
            </p>
          </SlackMessage>
          <SlackMessage who="my-agent" bot time="9:30 AM" className={when(step, 4, "sl-msg")}>
            <p className={step === 4 ? "md-streaming" : undefined}>
              Two incidents yesterday: the web deploy and a DNS blip.
            </p>
          </SlackMessage>
        </div>
      </div>
      <div className="md-calls">
        <p className="md-head">
          <span>Model calls</span>
          <span className="spacer" />
          <code>POST /v1/chat/completions</code>
        </p>
        <ol>
          <ModelCall step={step} at={1} dir="request">
            #1 “what broke yesterday?” · tools: <b>search_incidents</b>
          </ModelCall>
          <ModelCall step={step} at={2} dir="answer">
            tool_calls: <b>search_incidents</b>({"{"}"since":"yesterday"{"}"})
          </ModelCall>
          <ModelCall step={step} at={3} dir="request">
            #2 tool result: "web deploy: migration failed", "DNS blip"
          </ModelCall>
          <ModelCall step={step} at={4} dir="answer">
            stream: “Two incidents yesterday: …” · stop
          </ModelCall>
        </ol>
        <p className={when(step, 5, "md-done")}>
          <span className="md-pass">PASS</span>2 calls, both scripted · no secrets sent
        </p>
      </div>
    </div>
  );
}
