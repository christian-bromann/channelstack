# 0019: The binary minifies whitespace only

Status: accepted, after #49.

`scripts/bun-compile.ts` builds the server binary with `minify: { whitespace: true }`. It doesn't
rename identifiers or rewrite syntax.

## Why

WebdriverIO, which the browser actor runs on, decides by a function's name whether a client is a
browser:

```js
// @wdio/utils 10.2.0, src/monad.ts
var SCOPE_TYPES = { browser: function Browser() {}, element: function Element() {} };
if (scopeType.name === "Browser" && "capabilities" in options) client.capabilities = options.capabilities;
```

Bun's identifier minifier renames `Browser`, and its syntax minifier drops the name. Either way,
the browser session got no `capabilities`, and webdriver failed reading them
(`capabilities["appium:directConnectProtocol"]`). That broke every live step a person takes in
Slack's client, but only in the binary: running from source never minifies (#49).

Bundled with the binary's options and run under Bun 1.4.5:

| Minification | Result |
|---|---|
| none, or whitespace only | the browser actor starts |
| syntax only, identifiers only, or all | fails as above |
| `keepNames`, at the top level or inside `minify` | fails: the name is still mangled (Bun 1.4.5 drops even a class's name with it) |

Whitespace-only minification costs little. The server's bundle grows from 6.3 MB to 7.9 MB, and the
darwin-arm64 binary from 96 MB to 97 MB, since most of it is the Bun runtime. It also leaves alone
anything else in the dependencies that reads a name or a function's source.

## Guarded by

`test/acceptance/browser-bundle.test.ts` bundles the browser actor with the binary's own options
(`bun scripts/bun-compile.ts <entry> --bundle <dir>`) and starts it with headless Chrome. With full
minification it fails with the error the live run logged.

## Alternatives considered

- **`keepNames`.** It doesn't keep the names in Bun 1.4.5.
- **Rewriting the check in `@wdio/utils` at build time** (`scopeType === SCOPE_TYPES.browser`), as
  `literalImports` does for WebdriverIO's computed imports. Rejected: one more patch to a
  dependency's code, for one check of many that could read a name, and it breaks silently when the
  code changes.
- **Leaving WebdriverIO out of the bundle** and loading it at run time. Rejected: the binary has no
  `node_modules` next to it.

## Upstream

`@wdio/utils` comparing scope types by name rather than by identity is filed as
[webdriverio/webdriverio#16504](https://github.com/webdriverio/webdriverio/issues/16504). Bun's
`keepNames` not keeping names isn't filed. When WebdriverIO's check is fixed, this decision can go
back to full minification, with the test above still guarding it.
