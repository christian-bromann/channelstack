"""Runs a smoke scenario (docs/decisions/0002-smoke-scenario-format.md) through the Python SDK.

Usage: python run.py <scenario.yaml> [--mode auto|attach|start]
"""

import asyncio
import dataclasses
import json
import re
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal, cast

import yaml
from channelstack import ChannelstackError, connect
from channelstack.runtime.wait import WaitTimeoutError, wait_for

Check = Mapping[str, Any]
Step = Mapping[str, Any]


def snake_case(name: str) -> str:
    """Scenarios use the IR's camelCase names; Python's SDK uses snake_case."""
    return re.sub(r"[A-Z]", lambda match: f"_{match.group(0).lower()}", name)


def get(target: Any, key: str) -> Any:
    """One step into a value: an index or `length`, a mapping key, or an attribute. Missing values read as None."""
    if target is None:
        return None
    if isinstance(target, Sequence) and not isinstance(target, str):
        items = cast(Sequence[Any], target)
        if key == "length":
            return len(items)
        return items[int(key)] if key.isdigit() and int(key) < len(items) else None
    if isinstance(target, Mapping):
        return cast(Mapping[str, Any], target).get(key)
    return getattr(target, snake_case(key), None)


def plain(value: Any) -> Any:
    """A value as JSON would hold it, for comparing and printing."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: plain(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }
    if isinstance(value, Mapping):
        return {
            str(key): plain(item)
            for key, item in cast(Mapping[Any, Any], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [plain(item) for item in cast(Sequence[Any], value)]
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return repr(value)


class Runner:
    def __init__(self) -> None:
        self.variables: dict[str, Any] = {}

    def resolve(self, value: Any) -> Any:
        """`$name.path.to.value` → the saved value; `$$` is a literal `$`; lists and mappings are resolved inside."""
        if isinstance(value, str):
            if value.startswith("$$"):
                return value[1:]
            if not value.startswith("$"):
                return value
            name, *path = value[1:].split(".")
            if name not in self.variables:
                raise KeyError(f"Unknown variable ${name}")
            result = self.variables[name]
            for key in path:
                result = get(result, key)
            return result
        if isinstance(value, list):
            return [self.resolve(item) for item in cast(list[Any], value)]
        if isinstance(value, dict):
            return {
                key: self.resolve(item)
                for key, item in cast(dict[str, Any], value).items()
            }
        return value

    def matches(self, actual: Any, expected: Any) -> bool:
        """Does `actual` have everything `expected` asks for? Mappings match partially, everything else exactly."""
        if isinstance(expected, Mapping):
            wanted = cast(Mapping[str, Any], expected)
            return all(
                self.matches(get(actual, key), item) for key, item in wanted.items()
            )
        return plain(actual) == plain(expected)

    def failure(self, check: Check) -> str | None:
        actual = self.resolve(check["value"])
        shown = f"{json.dumps(check['value'])} = {json.dumps(plain(actual))}"
        if "equals" in check and not self.matches(
            actual, self.resolve(check["equals"])
        ):
            return (
                f"{shown}, expected {json.dumps(plain(self.resolve(check['equals'])))}"
            )
        if "matches" in check and not (
            isinstance(actual, str) and re.search(check["matches"], actual)
        ):
            return f"{shown}, expected a match for /{check['matches']}/"
        if "contains" in check:
            wanted = self.resolve(check["contains"])
            items = (
                cast(Sequence[Any], actual)
                if isinstance(actual, Sequence) and not isinstance(actual, str)
                else []
            )
            if not any(self.matches(item, wanted) for item in items):
                return f"{shown}, expected it to contain {json.dumps(plain(wanted))}"
        return None

    def assert_all(self, checks: Sequence[Check], number: int) -> None:
        failed = next(
            (message for message in map(self.failure, checks) if message is not None),
            None,
        )
        if failed is not None:
            raise AssertionError(f"step {number}: {failed}")

    async def call(self, step: Step) -> Any:
        name, method = str(step["call"]).split(".")
        target = getattr(self.variables.get(name), snake_case(method), None)
        if not callable(target):
            raise TypeError(f"{step['call']}: no such method")
        invoke = cast(Callable[..., Awaitable[Any]], target)
        args = cast(list[Any], self.resolve(step.get("args", [])))
        options = cast(dict[str, Any], self.resolve(step.get("options", {})))
        return await target(
            *args, **{snake_case(key): value for key, value in options.items()}
        )

    async def run(self, step: Step, number: int) -> None:
        if "expect" in step:
            self.assert_all(step["expect"], number)
        if "call" not in step:
            return
        if "throws" in step:
            try:
                await self.call(step)
            except ChannelstackError as error:
                if error.code == step["throws"]:
                    return
                raise AssertionError(
                    f"step {number}: {step['call']} should fail with {step['throws']}, got {error.code}"
                ) from error
            raise AssertionError(
                f"step {number}: {step['call']} should fail with {step['throws']}, got no error"
            )

        async def save() -> None:
            result = await self.call(step)
            if "as" in step:
                self.variables[step["as"]] = result

        if "until" not in step:
            await save()
            return
        last: list[str | None] = [None]

        async def attempt() -> bool | None:
            await save()
            last[0] = next(
                (
                    message
                    for message in map(self.failure, step["until"])
                    if message is not None
                ),
                None,
            )
            return True if last[0] is None else None

        try:
            await wait_for(f"step {number} ({step['call']})", attempt)
        except WaitTimeoutError as error:
            raise AssertionError(f"step {number}: {last[0] or error}") from error


async def main(file: str, mode: Literal["auto", "attach", "start"]) -> None:
    scenario = yaml.safe_load(Path(file).read_text())
    runner = Runner()
    async with (
        await connect(mode=mode) as channelstack,
        await channelstack.open_session() as session,
    ):
        runner.variables.update(channelstack=channelstack, session=session)
        for index, step in enumerate(scenario["steps"]):
            await runner.run(step, index + 1)
    print(f"ok {scenario['name']} (python, {len(scenario['steps'])} steps)")


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if not arguments:
        raise SystemExit(
            "Usage: python run.py <scenario.yaml> [--mode auto|attach|start]"
        )
    chosen = (
        arguments[arguments.index("--mode") + 1] if "--mode" in arguments else "auto"
    )
    asyncio.run(main(arguments[0], cast(Literal["auto", "attach", "start"], chosen)))
