#!/bin/sh
# A server whose GitHub is live against a stand-in for GitHub's API (server/test/github-live-stub.ts):
# for an acceptance test that must send nothing to GitHub. It takes `start`'s arguments and ignores them.
exec bun "$(dirname "$0")/github-live-server.ts"
