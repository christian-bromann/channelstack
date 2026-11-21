# 0008: How a browser gets into the UI, and what it may do

Status: accepted, phase 1.

## Context

devx.md says the UI "opens through a one-time login link printed on start". The control API is protected by a bearer token that programs read from `server.json`; a browser has no such file, and the control API returns the agent's fake tokens (`GET /env`, the fixtures).

## Decision

- The server prints a link with a **one-time code** when it starts; `channelstack ui` prints a fresh one (`POST /_channelstack/ui/login-links`, bearer token). Opening the link trades the code for a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` on https) and redirects to the plain address, so the code doesn't stay in the address bar. Codes and sessions are CSPRNG values, live in memory, end with the server, and are registered with the redactor.
- The cookie authorizes **reads the UI shows, and nothing else**: `GET /status`, a session's events and quiet state, and a driver's people and conversations (transcripts included). Not `/env`, not a fixture, no request that changes anything. The list is one expression in `server/src/core/auth/ui.ts`.
- What a browser session reads is **scrubbed of tokens and secrets** on the way out (`Redactor.tokens`), whatever a message contains.
- The page is served with a per-response nonce and a content security policy that runs only the page's own script and style. The page sets everything an agent or a person wrote as text, never as markup.
- UI v0 is **one static HTML file** (`ui/index.html`) with no build step, compiled into the binary as text. It only reads: transcripts and the inspector. Acting from the UI (buttons, Stop) comes with phase 2.

## Why

A cookie is sent by the browser on its own, so it must not be worth stealing a request with: with reads only and `SameSite=Strict`, a page that tricks the browser into a request gains nothing, and can't read the answer. The agent's tokens stay behind the bearer token, which only local programs have.

## Alternatives considered

- **Put the bearer token in the link and let the page use it.** Rejected: the token would sit in the address bar, the history and the page's memory, and it authorizes everything.
- **No login at all on loopback.** Rejected: any local page could read transcripts and events through the browser.
- **A UI built with a framework and a bundler.** Deferred: v0 is a few hundred lines. Revisit when the UI grows controls in phase 2.
