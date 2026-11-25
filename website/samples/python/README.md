# Python samples

The Python versions of the home page examples, shown by the TS | Py switch. They mirror the
TypeScript samples one to one, step for step, using `pytest-channelstack`'s `expect(...)` and the
Python SDK.

They're type-checked against the real packages: `pnpm typecheck` at the repository root runs
pyright (strict) over this folder in `integrations/pytest-channelstack`'s environment, so a method,
option or matcher that doesn't exist fails CI. `pnpm typecheck:samples` here also checks that they
parse. Each test names its fixture's type (`slack: SlackFixture`) so the check reaches every call.
