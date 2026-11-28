# Phase 14 plan

Phase 14 of [docs/phases.md](../../docs/phases.md): the fake OpenAI's images, audio, files and built-in tools ([decision 0029](../../docs/decisions/0029-fake-openai.md); design: [interface-draft.md](../model-providers/interface-draft.md) §5.5 and §5.6, cited as "design §n").

**Stacked on phase 13** on the maintainer's instruction: the branch starts from `phase-13-openai` (christian-bromann/channelstack#116, in review), the PR targets that branch, and is retargeted to `main` and merged only once #116 is merged and `phase-13-done` is tagged.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 14.1 The examples pass | the "images and built-in tools" block of `test/acceptance/examples/openai.test.ts`, against `examples/agents/openai-ai-sdk` only (the harness gains per-agent examples) | `examples/agents/openai-ai-sdk/agent.ts`, `examples/agents/shared/model-agent.ts`, `scripts/lib/channels.ts`, `scripts/examples.ts` |
| 14.2 Media in requests | `server/src/providers/openai/media.test.ts` (data URL, `file_id`, URL parts on both endpoints, each with media type, size and SHA-256; `url_private` refused with `invalid_image_url`; a public fake-host URL fetched; other URLs recorded, not fetched); `integrations/matchers-core/matchers.test.ts`, the pytest and Rust matcher tests (`toHaveSentFile`) | `providers/openai/media.ts`, `request.ts`, `routes.ts` (parts on the wire), `core/router/driver.ts` + `app.ts` (`fetchFake`), matchers-core, pytest plugin, Rust `expect` |
| 14.3 Media in answers | `server/src/providers/openai/media-sdk.test.ts` with the official `openai` SDK: images generations and edits (`b64_json`, `url`; png, and a file for jpeg/webp), speech (every `response_format`, `stream_format: "sse"`), transcriptions (json, text, srt, vtt, verbose_json, streamed), translations, Chat Completions audio output (streamed and not); the placeholders decode as PNG and WAV; a placeholder in mp3 or jpeg is a script problem. Every answer and event held to the pinned description | `providers/openai/media.ts`, `codecs/media.ts`, `codecs/chat.ts`, `api.ts`, `turns.ts`, `server/test/schemas/openai.ts` |
| 14.4 Built-in tools | `server/src/providers/openai/tools/tools.test.ts`: per tool, its items and events against the pinned description (non-streamed and streamed); a tool the request didn't offer is a script problem; the MCP approval round trip; a client-run tool's output joined in `toolCalls()`; `/v1/files` and container file downloads | `providers/openai/tools/` (one file per tool), `codecs/responses.ts`, `request.ts`, `routes.ts`, `scripts.ts` |
| 14.5 Every SDK uploads media | `sdks/typescript/runtime/runtime.test.ts`, `sdks/python/tests/test_media.py`, `sdks/rust/tests/media.rs`: `readMedia` for a path, bytes and a placeholder; `test/acceptance/providers/openai-media.test.ts` and its pytest and Rust counterparts: a `MediaSource` given as a path is read in the test process and served by the fake byte for byte | `codegen` (`x-channelstack-files: "media"`), the `files` runtime module of each SDK |

## Reuse

| Concern | From |
|---|---|
| One call from arrival to end: attribution, scripts, timing, recording | `providers/openai/api.ts` (`answerCall`), extended to the media endpoints rather than a second call path |
| A request as one shape | `providers/openai/request.ts` (`ModelRequest`), with `prompt` and `file` for the media endpoints (design §4.4) |
| A turn and its checks | `turns.ts`, `scripts.ts` (`problemsOf`): built-in tools and placeholders add their problems there |
| SSE with timing and breaks | `core/stream/` (`sseStream`): transcription and speech streams and the tools' events are frames like any other |
| Output items and events | `codecs/responses.ts`, which asks `tools/` for each built-in item's item and events |
| Ids | `providers/openai/ids.ts` (new kinds: `file-…`, `ws_…`, `fs_…`, `ci_…`, `ig_…`, `mcp_…`, `mcpr_…`, `mcpl_…`, `sh_…`, `cu_…`, `apc_…`, `cntr_…`, `cfile_…`, `audio_…`) |
| Fixture files a test hands over | each SDK's `files` runtime module (`readTree`, `readDocument`); `readMedia` is its new member, and the generator a new `files` mode |
| Fetching a fake host's URL | the app's own `fetch`, through a new `DriverContext.fetchFake` (the provider can't import a driver, so core does the routing) |
| Multipart bodies | Hono's `parseBody` (already a dependency) |
| PNG's deflate and CRC | `node:zlib` (`deflateSync`, `crc32`) |
| Hashes | `node:crypto` (`createHash("sha256")`) |
| Schema checks of answers | `server/test/schemas/openai.ts`, with the media endpoints' and files' schemas |

## Changes beside the plan

- **A Slack message lists its files' names** (`files` on `SlackMessage`): the example `expect(reply.files).toHaveLength(1)` needs it, so the route changed, not the example.
- **A string tree (`files: "./fixtures/error.png"`) may be one file**, not only a directory, in all three SDKs (`readTree`, `read_tree`): the example shares one file.
- **The Rust SDK encodes a union holding files or handles** (`enc::union`): a turn's media, and `when`'s `from`/`in` sent as ids, as TypeScript sends them.

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `sha2` (Rust SDK) | 0.11.1 | SHA-256 for `to_have_sent_file`: the Rust SDK has no hash, and RustCrypto's is the standard one, pure Rust | MIT OR Apache-2.0 | Yes (RustCrypto; 0.11.2 is two days old, so 0.11.1 is pinned) |

The server and the TypeScript and Python SDKs need none: `node:crypto` and `node:zlib`, and Python's `hashlib`.

## Docs to update

- reality-matrix: the media endpoints and built-in tools;
- `code-map.md`: `media.ts`, `tools/`, `codecs/media.ts`, `fetchFake`, `readMedia`;
- the website's page for the fake model (`website/docs/guide/the-model.mdx`): images, audio, files and built-in tools.
