# Phase 6 closed

Pull request: [christian-bromann/channelstack#23](https://github.com/christian-bromann/channelstack/pull/23), squash-merged on 2026-11-25 and tagged `phase-6-done`.

## What was built

- **Proxy mode** (`channelstack start --proxy`): a loopback HTTP proxy.
  - Each driver's `hosts` (`slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`) go to a TLS listener that the fakes answer. Every other host is tunnelled through.
  - The fakes' own URLs are the providers' too.
  - A live driver's calls are passed on to the platform.
- **channelstack's CA** (`core/ca`), in `<home>/ca/` (0600):
  - name-constrained to the routed hosts, not their subdomains, and no IP address;
  - never in a system trust store;
  - `channelstack ca rotate` replaces it.
- **`channelstack env --proxy`** prints, besides the fake tokens:
  - the proxy;
  - `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` (the public roots plus the CA);
  - a Node preload that keeps Node's proxy-aware `fetch` when an agent loads undici (Bolt does).
- **A Go reference agent** (`slack-go`), run in Docker in proxy mode.
- **The differential run** (`pnpm conformance`): one scenario per channel, run against the fake and against the sandbox.
  - The recordings are normalized and compared.
  - The recorder (`--record`) writes the shapes of every exchange and webhook, from the proxy, the fake's delivery queue and a tap on each live relay. The shape differ compares them operation by operation.
  - `conformance/divergences.yaml` lists each allowed difference, with a reason and an expiry.
- **The coverage page** (`pnpm coverage`), from the capabilities, the divergences and a run's results. CI publishes it with every run; the nightly job adds results.

## The gate

`pnpm verify:phase 6` passes in CI on the last head, with each acceptance part three times, including `proxy` (6.1, and 6.2 in Docker) and `conformance`. Locally, the differential run against all four sandboxes had every difference fixed or recorded, and its sweep check found nothing left.

## What the differential run found

- **Fixed in the fakes:**
  - GitHub: a test repository's visibility is one default, private, in both worlds.
  - Linear: delegating records the person's opening prompt.
  - Notion: every answer has a `request_id`.
- **Fixed in a reference agent:** a race in the Linear agents' Stop.
- **Recorded:** the fakes' gaps, with issues [#25](https://github.com/christian-bromann/channelstack/issues/25) (GitHub), [#26](https://github.com/christian-bromann/channelstack/issues/26) (Linear), [#27](https://github.com/christian-bromann/channelstack/issues/27) (Notion) and [#30](https://github.com/christian-bromann/channelstack/issues/30) (Slack). Also where live mode puts a session's Notion pages.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 17 (1 blocking: the CA vouched for the routed hosts' subdomains; 9 should-fix, 7 nits) | 16 fixed, 1 deferred (#28) |
| 2 | changes required | 5 (1 blocking: recordings held the fake secrets again), and 2 reopened round-1 findings | All fixed |
| 3 | approved | 2 nits | Both fixed |

Every thread is resolved.

## Deferred

- **6.4 and 6.5 on `main`:** the nightly job's first run, which needs the workflow on `main`. [#31](https://github.com/christian-bromann/channelstack/issues/31).
- **Reading a live agent's calls back through the proxy:** [#24](https://github.com/christian-bromann/channelstack/issues/24).
- **Slack's real webhooks for the shape differ:** [#28](https://github.com/christian-bromann/channelstack/issues/28).
- **Notion's seeded pages,** which send `page.created` live and nothing in the fake: [#29](https://github.com/christian-bromann/channelstack/issues/29).

## For the maintainer

- **CA upgrade:** a CA in `~/.channelstack/ca` from before this phase is replaced at the next start, because it let subdomains through. Agents read the new one from the same files.
- **Nightly secrets:** Ana's Slack session was signed in again, and `pnpm live:secrets` refreshed the nightly job's copy.
- **Contract changes:**
  - `api/server.d.ts`: `env(options?: { proxy?: boolean })`.
  - `api/github.d.ts`: documents `private`'s default, true.
  - `api/matchers.d.ts`: `toHaveActivity` matches the agent's activities only.
