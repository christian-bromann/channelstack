"""What generated handles share: their context, and the root client's connection."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Self

from .launcher import Mode, launch
from .transport import ChannelstackError, Transport


@dataclass(frozen=True)
class HandleContext:
    """What a handle needs to call the server: the transport, and the session it lives in."""

    transport: Transport
    session: str | None


def session_of(context: HandleContext) -> str:
    """The session a handle lives in. Only the root client has none."""
    if context.session is None:
        raise RuntimeError("This handle doesn't belong to a session")
    return context.session


class ClientBase:
    """Base of the generated root client: closing it stops the server if this client started it."""

    def __init__(self, transport: Transport, stop: Callable[[], Awaitable[None]]) -> None:
        self._transport = transport
        self._stop = stop

    async def close(self) -> None:
        await self._transport.close()
        await self._stop()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


@dataclass(frozen=True)
class Protocol:
    """What the generated SDK knows about the protocol it was generated from."""

    base_path: str
    errors: Mapping[str, type[ChannelstackError]]
    version: str


async def connect_with[T](
    create: Callable[[Transport, Callable[[], Awaitable[None]]], T],
    protocol: Protocol,
    *,
    mode: Mode,
    server: str | None,
) -> T:
    """Find or start the server, check that it speaks this SDK's major version, and build the root client."""
    connection = await launch(mode, server)
    transport = Transport(
        url=connection.url, token=connection.token, base_path=protocol.base_path, errors=protocol.errors
    )
    try:
        version = str((await transport.request("GET", "/status"))["version"])
        if version.split(".")[0] != protocol.version.split(".")[0]:
            raise RuntimeError(
                f"The channelstack server is version {version}, but this SDK was generated for {protocol.version}"
            )
    except BaseException:
        await transport.close()
        await connection.stop()
        raise
    return create(transport, connection.stop)
