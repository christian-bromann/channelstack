import type { LinearIssueRecord, LinearOrgRecord, LinearUserRecord } from "./world.ts";

/** Linear's URL slug of a title: `Checkout fails on Safari` → `checkout-fails-on-safari`. */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Where things are in Linear's web app, on the fake's host: `https://linear.localhost/acme/issue/ENG-1/…`. */
export function linearLinks(base: () => string, org: () => LinearOrgRecord) {
  const root = () => `${base()}/${org().urlKey}`;
  const issue = (record: LinearIssueRecord) => `${root()}/issue/${record.identifier}/${slug(record.title)}`;
  return {
    issue,
    comment: (record: LinearIssueRecord, comment: string) => `${issue(record)}#comment-${comment.slice(0, 8)}`,
    /** A person's profile. In Markdown, Linear writes a mention as this link. */
    profile: (user: LinearUserRecord) => `${root()}/profiles/${user.displayName}`,
    session: (record: LinearIssueRecord, slugId: string) => `${issue(record)}#agent-session-${slugId}`,
    team: (key: string) => `${root()}/team/${key}`,
    /** Every profile link in a Markdown text: where a mention is. */
    profilePattern: () =>
      new RegExp(`${root().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/profiles/([A-Za-z0-9._-]+)`, "g"),
  };
}

export type LinearLinks = ReturnType<typeof linearLinks>;
