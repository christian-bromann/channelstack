"""The HTTP client every generated method goes through: bearer token, retries while the server starts, typed errors."""

import asyncio
import time
from collections.abc import Callable, Mapping
from typing import Any, cast

import httpx

# How long to keep retrying a connection that is refused, while the server starts.
_CONNECT_RETRY_S = 5.0
_CONNECT_RETRY_INTERVAL_S = 0.1


class ChannelstackError(Exception):
    """An error from the control API. `code` is the protocol's stable error code."""

    def __init__(self, code: str, status: int, message: str, data: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.data: Mapping[str, Any] = data or {}


_refusal_handler: Callable[[ChannelstackError, str], None] | None = None


def on_refusal(handler: Callable[[ChannelstackError, str], None] | None) -> None:
    """Set (or, with None, clear) what sees every refusal before it is raised.

    A test integration uses it to turn a refusal into its framework's own outcome: an operation
    live mode can't do skips the test, with the reason.
    """
    global _refusal_handler
    _refusal_handler = handler


def _without_none(values: Mapping[str, Any] | None) -> dict[str, Any] | None:
    return None if values is None else {key: value for key, value in values.items() if value is not None}


class Transport:
    def __init__(self, *, url: str, token: str, base_path: str, errors: Mapping[str, type[ChannelstackError]]) -> None:
        self._base_path = base_path
        self._errors = errors
        self._client = httpx.AsyncClient(base_url=url, headers={"authorization": f"Bearer {token}"}, timeout=30.0)

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int | bool | None] | None = None,
    ) -> Any:
        response = await self._send(method, f"{self._base_path}{path}", _without_none(body), _without_none(query))
        try:
            payload: Any = response.json() if response.content else None
        except ValueError:
            # Not the control API talking: a proxy's error page, for example.
            status = response.status_code
            raise ChannelstackError("internal", status, f"HTTP {status}: the response is not JSON") from None
        if response.is_success:
            return payload
        error = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
        code = str(error.get("error", "internal"))
        error_class = self._errors.get(code, ChannelstackError)
        refusal = error_class(
            code, response.status_code, str(error.get("message", f"HTTP {response.status_code}")), error.get("data")
        )
        if _refusal_handler is not None:
            _refusal_handler(refusal, path)
        raise refusal

    async def _send(
        self, method: str, path: str, body: dict[str, Any] | None, query: dict[str, Any] | None
    ) -> httpx.Response:
        deadline = time.monotonic() + _CONNECT_RETRY_S
        while True:
            try:
                return await self._client.request(method, path, json=body, params=query)
            except httpx.ConnectError:
                # Nothing was sent, so retrying is safe.
                if time.monotonic() > deadline:
                    raise
                await asyncio.sleep(_CONNECT_RETRY_INTERVAL_S)

    async def close(self) -> None:
        await self._client.aclose()
