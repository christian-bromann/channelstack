"""Find or start the server: `auto` attaches if one is running and starts one otherwise."""

import asyncio
import atexit
import json
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

import httpx

from .wait import wait_for

Mode = Literal["auto", "attach", "start"]

_STATUS_PATH = "/_channelstack/status"


async def _nothing_to_stop() -> None:
    return None


@dataclass(frozen=True)
class ServerConnection:
    """A server to talk to. `stop` only stops a server this launcher started."""

    url: str
    token: str
    stop: Callable[[], Awaitable[None]] = _nothing_to_stop


def _read_server_file(path: Path) -> ServerConnection | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    contents = cast(dict[str, Any], data)
    url, token = contents.get("url"), contents.get("token")
    return ServerConnection(url.rstrip("/"), token) if isinstance(url, str) and isinstance(token, str) else None


async def _is_up(server: ServerConnection) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(
                f"{server.url}{_STATUS_PATH}", headers={"authorization": f"Bearer {server.token}"}
            )
        return response.is_success
    except httpx.HTTPError:
        return False


def _attach_target(server: str | None, env: Mapping[str, str]) -> ServerConnection | None:
    """The running server a client should attach to, if there is one: an explicit URL, or the one in server.json."""
    # An empty variable (an unset CI secret) counts as not set, and a trailing slash doesn't matter.
    url = (server or env.get("CHANNELSTACK_URL") or "").rstrip("/") or None
    home = Path(env.get("CHANNELSTACK_HOME") or Path.home() / ".channelstack")
    from_file = _read_server_file(home / "server.json")
    if url is None:
        return from_file
    token = env.get("CHANNELSTACK_TOKEN") or (from_file.token if from_file and from_file.url == url else None)
    return None if token is None else ServerConnection(url, token)


def resolve_server_binary(env: Mapping[str, str]) -> str:
    """The server binary: CHANNELSTACK_SERVER_BIN, or `channelstack` on the PATH."""
    binary = env.get("CHANNELSTACK_SERVER_BIN") or shutil.which("channelstack")
    if not binary:
        raise RuntimeError("No channelstack server binary found. Set CHANNELSTACK_SERVER_BIN, or install channelstack.")
    return binary


async def _start_server(env: Mapping[str, str]) -> ServerConnection:
    """Start a private server on a free loopback port. Its token goes to a private file, never to the shared one."""
    directory = Path(tempfile.mkdtemp(prefix="channelstack-"))
    server_file = directory / "server.json"
    process = await asyncio.create_subprocess_exec(
        resolve_server_binary(env),
        "start",
        "--no-portless",
        "--port",
        "0",
        "--server-file",
        str(server_file),
        env=dict(env),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
    )

    # If this process ends without closing the client, the server must not outlive it.
    def on_process_exit() -> None:
        if process.returncode is None:
            process.terminate()
        shutil.rmtree(directory, ignore_errors=True)

    atexit.register(on_process_exit)

    async def stop() -> None:
        atexit.unregister(on_process_exit)
        if process.returncode is None:
            process.terminate()
        await process.wait()
        shutil.rmtree(directory, ignore_errors=True)

    async def ready() -> ServerConnection | None:
        if process.returncode is not None:
            raise RuntimeError(f"The channelstack server exited before it was ready (code {process.returncode})")
        server = _read_server_file(server_file)
        return server if server and await _is_up(server) else None

    try:
        server = await wait_for("the channelstack server to start", ready, timeout="15s")
    except BaseException:
        await stop()
        raise
    return ServerConnection(server.url, server.token, stop)


async def launch(
    mode: Mode = "auto", server: str | None = None, env: Mapping[str, str] | None = None
) -> ServerConnection:
    env = os.environ if env is None else env
    if mode != "start":
        target = _attach_target(server, env)
        if target and await _is_up(target):
            return target
        if mode == "attach":
            where = (
                f"No channelstack server is answering at {target.url}."
                if target
                else "No running channelstack server found."
            )
            raise RuntimeError(f"{where} Start one with `npx channelstack`.")
    return await _start_server(env)
