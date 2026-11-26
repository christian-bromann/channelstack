# Security

channelstack holds real tokens in live mode and can act in real workspaces, so security reports are
taken seriously.

## Reporting a vulnerability

Report it privately, through GitHub's
[private vulnerability reporting](https://github.com/christian-bromann/channelstack/security/advisories/new).
Don't open a public issue. Please include what is affected, how to reproduce it, and what an
attacker could do with it.

You'll get an answer within a week. A fix is released as soon as it's ready, with an advisory
that credits you, unless you'd rather not be named.

## What counts

- A way to reach the control API or the UI without the bearer token or a login link, or from
  another machine.
- A token, signing secret or live credential that ends up in a log, an error, a recording, the
  event log or the UI.
- Live mode acting outside its allowlists, or leaving something behind that its cleanup or
  `channelstack sweep` should have removed.
- Proxy mode's CA vouching for a host other than the platforms it routes.
- A compromised dependency, or a release that doesn't match its source.

## Supported versions

Fixes go into the newest release. Before 1.0, older versions aren't patched.
