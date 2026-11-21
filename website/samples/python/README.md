# Python samples

The Python versions of the home page examples, shown by the TS | Py switch. They mirror the
TypeScript samples one to one, in the snake_case shape `docs/architecture.md` describes for the
generated Python SDK.

`pnpm typecheck:samples` only checks that these files parse as Python (`scripts/check-python-samples.mjs`).
Unlike the `.ts` samples they are **not** checked against `api/*.d.ts`, because the Python SDK
doesn't exist yet: the `pytest_channelstack` import, the `expect(...)` matchers and their names are
the planned shape, not a tested one. Update them by hand when the API changes, and replace this
check with a real one once the Python SDK ships.

`pytest_channelstack.pyi` in this folder is a stand-in for the plugin, so the repository's Python
type-checker can resolve the samples' import. It is not the real API.
