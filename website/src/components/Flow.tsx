/**
 * How it works: the test scripts channelstack, channelstack sends signed webhooks to the
 * agent, and the agent's API calls come back to the same fake workspace. The moving dots
 * are decoration; the text carries the meaning.
 */
export function Flow() {
  return (
    <figure className="flow reveal">
      <div className="flow-grid">
        <div className="node">
          <h3>Your test</h3>
          <ul>
            <li>ana.say(…)</li>
            <li>ana.click("Approve", …)</li>
            <li>expect(thread)</li>
          </ul>
          <p className="node-foot">vitest · pytest</p>
        </div>

        <div className="wires" aria-hidden="true">
          <div className="wire w1">
            <span className="wire-label">script + assert</span>
            <span className="track">
              <i />
            </span>
          </div>
        </div>

        <div className="node accent">
          <h3>channelstack</h3>
          <ul>
            <li>fake workspaces</li>
            <li>people + delivery</li>
            <li>fake platform APIs</li>
            <li>schema checks</li>
          </ul>
          <p className="node-foot">slack.localhost · github.localhost · linear.localhost · notion.localhost</p>
        </div>

        <div className="wires" aria-hidden="true">
          <div className="wire w2">
            <span className="wire-label">signed webhooks</span>
            <span className="track">
              <i />
            </span>
          </div>
          <div className="wire w3 back">
            <span className="wire-label">API calls</span>
            <span className="track">
              <i />
            </span>
          </div>
        </div>

        <div className="node">
          <h3>Your agent</h3>
          <ul>
            <li>unchanged code</li>
            <li>real SDKs</li>
            <li>its own config</li>
          </ul>
          <p className="node-foot">channelstack env</p>
        </div>
      </div>
      <figcaption>
        <span className="sr-only">
          Your test scripts people and asserts through channelstack. channelstack sends signed webhooks to your agent,
          and your agent’s API calls go back to channelstack’s fake platform APIs.{" "}
        </span>
        In proxy mode, requests to hosts channelstack doesn’t emulate pass through untouched.
      </figcaption>
    </figure>
  );
}
