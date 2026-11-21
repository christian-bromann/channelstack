#!/bin/sh
# Runs the server from source with Bun, with the same arguments as the compiled binary.
#
# For machines that won't execute a freshly compiled, ad-hoc signed binary (for example under a
# binary-authorization tool in lockdown mode). Point the tests at it:
#
#   CHANNELSTACK_SERVER_BIN="$PWD/scripts/dev-server.sh" pnpm test:integration
#
# The gate in CI always runs the compiled binary; this is only a local convenience. It needs `bun`
# on the PATH, so the one test that starts the server with an empty PATH can't pass through it.
exec bun "$(dirname "$0")/../server/src/cli.ts" "$@"
