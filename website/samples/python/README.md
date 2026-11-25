# Python samples

The Python versions of the home page examples, shown by the TS | Py switch. They mirror the
TypeScript samples one to one, in the snake_case shape `docs/architecture.md` describes for the
generated Python SDK.

`pnpm typecheck:samples` only checks that these files parse as Python (`scripts/check-python-samples.mjs`).
Unlike the `.ts` samples they are **not** checked against the API yet. `pytest-channelstack` exists
(`integrations/pytest-channelstack`, with `expect(...)` as [decision 0018](../../../docs/decisions/0018-pytest-expect.md)
describes), but it has only the conversation matchers so far; `to_have_button`, `to_contain_text`,
`to_have_comment_from` and the Linear ones the samples use come with the rest of the matcher set.
Update the samples by hand when the API changes, and check them against the real package once it has them.

`pytest_channelstack.pyi` in this folder is a stand-in for the plugin, so the repository's Python
type-checker can resolve the samples' import. It is not the real API.
