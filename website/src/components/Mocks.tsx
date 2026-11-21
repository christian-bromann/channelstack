import type { ReactNode } from "react";
import { Check } from "./Icons";

/**
 * What each example's test produces, drawn in the shape of the platform it runs on: a Slack
 * thread, a GitHub issue, a Linear agent session, a Notion page with comments. These are
 * channelstack's own drawings in its own colours, not copies of the products' interfaces.
 */

function Frame({ host, title, badge, children, checks }: { host: string; title: ReactNode; badge?: ReactNode; children: ReactNode; checks: string[] }) {
  return (
    <div className="mock">
      <div className="pane-head">
        <span className="chan">{title}</span>
        {badge}
        <span className="spacer" />
        <span className="tag">{host}</span>
      </div>
      <div className="mock-body">{children}</div>
      <ul className="mock-checks">
        {checks.map((check) => (
          <li key={check}>
            <Check size={13} />
            {check}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Avatar({ name, bot = false }: { name: string; bot?: boolean }) {
  return (
    <span className={bot ? "avatar bot" : `avatar person-${name.toLowerCase()}`} aria-hidden="true">
      {name[0]!.toUpperCase()}
    </span>
  );
}

function Message({ who, bot = false, meta, children }: { who: string; bot?: boolean; meta?: string; children: ReactNode }) {
  return (
    <div className="msg m-item">
      <Avatar name={who} bot={bot} />
      <div>
        <p className="who">
          {who} {bot ? <span className="tag">APP</span> : null} {meta ? <small>{meta}</small> : null}
        </p>
        {children}
      </div>
    </div>
  );
}

const Mention = ({ children }: { children: string }) => <span className="mention">{children}</span>;

export function SlackMock() {
  return (
    <Frame host="slack.localhost" title="# incidents" checks={["1 reply from robin, in the thread", "nothing posted to the channel"]}>
      <Message who="Ana" meta="9:02">
        <p>
          <Mention>@robin</Mention> summarize yesterday’s incidents
        </p>
      </Message>
      <div className="m-thread">
        <Message who="robin" bot meta="9:02">
          <p>Two incidents yesterday: checkout latency, resolved in 14 minutes, and a failed deploy that was rolled back.</p>
        </Message>
        <p className="m-meta m-item">1 reply</p>
      </div>
    </Frame>
  );
}

export function GitHubMock() {
  return (
    <Frame host="github.localhost" title="acme/web" checks={["robin commented once", "the redelivery started no second run"]}>
      <div className="m-title m-item">
        <h4>
          Login 500s on Safari <span>#1</span>
        </h4>
        <span className="m-pill ok">Open</span>
      </div>
      <div className="m-comment m-item">
        <p className="m-comment-head">
          <Avatar name="mo" /> <b>mo</b> commented
        </p>
        <p>
          <Mention>@robin</Mention> can you take a look?
        </p>
      </div>
      <div className="m-comment m-item">
        <p className="m-comment-head">
          <Avatar name="robin" bot /> <b>robin</b> <span className="tag">bot</span> commented
        </p>
        <p>Reproduced on Safari 17: the session cookie is dropped on the redirect. A fix is on the way.</p>
      </div>
      <p className="m-event m-item">
        <i /> delivery redelivered with the same GUID
      </p>
    </Frame>
  );
}

export function LinearMock() {
  return (
    <Frame host="linear.localhost" title="ENG-1" checks={["the session showed a thought", "Stop ended it: session complete"]}>
      <div className="m-title m-item">
        <h4>Migrate billing cron</h4>
      </div>
      <p className="m-props m-item">
        <span className="m-pill">In Progress</span>
        <span className="m-pill">Delegated to robin</span>
        <span className="m-pill">Kai</span>
      </p>
      <div className="m-session m-item">
        <p className="m-comment-head">
          <Avatar name="robin" bot /> <b>robin</b> <span className="tag">agent session</span>
          <span className="spacer" />
          <span className="m-pill ok">Complete</span>
        </p>
        <ul>
          <li>
            <i /> Kai delegated the issue
          </li>
          <li>
            <i className="think" /> <em>Thought:</em> reading the cron definitions
          </li>
          <li>
            <i className="stop" /> Kai stopped the session
          </li>
        </ul>
      </div>
    </Frame>
  );
}

export function NotionMock() {
  return (
    <Frame host="notion.localhost" title="Roadmap" checks={["robin answered in the same discussion", "exactly one comment from robin"]}>
      <div className="m-page">
        <div className="m-doc m-item">
          <h4>Roadmap</h4>
          <p className="m-h">Q1</p>
          <ul>
            <li>ship search</li>
          </ul>
        </div>
        <div className="m-discussion">
          <Message who="Ana" meta="now">
            <p>
              <Mention>@robin</Mention> summarize this page
            </p>
          </Message>
          <Message who="robin" bot meta="now">
            <p>Q1 has one goal: ship search.</p>
          </Message>
        </div>
      </div>
    </Frame>
  );
}

export function LiveMock() {
  return (
    <Frame
      host="slack.com"
      title="# cs-test-4f2a"
      badge={
        <span className="m-live">
          <i /> live
        </span>
      }
      checks={["reply from robin within 30s", "cleaned up: 1 channel, 2 messages"]}
    >
      <Message who="Ana" meta="14:10">
        <p>
          <Mention>@robin</Mention> summarize #support today
        </p>
      </Message>
      <div className="m-thread">
        <Message who="robin" bot meta="14:10">
          <p>Today in #support: 12 new tickets, 9 closed. Two are waiting on billing.</p>
        </Message>
      </div>
    </Frame>
  );
}

export function PytestMock() {
  return (
    <Frame host="slack.localhost" title="# ops" checks={["“Okay, I left the keys alone.” appears once"]}>
      <Message who="Ana" meta="11:20">
        <p>
          <Mention>@robin</Mention> rotate the staging keys
        </p>
      </Message>
      <div className="m-thread">
        <Message who="robin" bot meta="11:20">
          <p>Rotate the staging keys? This restarts three services.</p>
          <p className="buttons">
            <span className="sbtn">Approve</span>
            <span className="sbtn is-picked">Reject</span>
          </p>
        </Message>
        <Message who="robin" bot meta="11:21">
          <p>Okay, I left the keys alone.</p>
        </Message>
      </div>
    </Frame>
  );
}
