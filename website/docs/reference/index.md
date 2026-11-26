---
title: "Overview"
order: 0
description: "The channelstack reference: the CLI, environment variables and SDKs, every platform's API, and the test API: the Vitest plugin, the client, the matchers and errors."
---

# Overview

Everything channelstack has, laid out to look things up. To learn how to use it, start with the [Guide](/docs).

## Tools

| Page | What it lists |
|---|---|
| [CLI](/docs/reference/cli) | Every `channelstack` command and flag |
| [Environment variables](/docs/reference/environment-variables) | What the server, the CLI and the SDKs read, and what `channelstack env` prints |
| [SDKs](/docs/reference/sdks) | The TypeScript, Python and Rust SDKs: installing, connecting, and how names differ between them |

## Platform APIs

One page per platform: every handle, field, method and wait of its fake, each call shown in TypeScript, Python and Rust.

- [Slack API](/docs/reference/api/slack)
- [GitHub API](/docs/reference/api/github)
- [Linear API](/docs/reference/api/linear)
- [Notion API](/docs/reference/api/notion)
- [Resend API](/docs/reference/api/resend)
- [Google API](/docs/reference/api/google)

## Test API

| Page | What it lists |
|---|---|
| [Vitest plugin](/docs/reference/vitest-plugin) | `channelstack()` and its options, and the fixtures a test gets |
| [Client and sessions](/docs/reference/api/client) | Connecting, the session each test runs in, and what it reports |
| [Matchers](/docs/reference/matchers) | Every `expect(…)` check: what it takes, how it waits, and how it fails; the pytest name next to each |
| [Errors](/docs/reference/api/errors) | Every error code: what channelstack's own mean, and the platforms' that the fakes send |

The client, platform API and errors pages are generated from the same spec as the SDKs, so they always match the code.
