"""Stand-in for the pytest-channelstack plugin, which doesn't exist yet.

The Python samples import `expect` from it. This stub lets type-checkers resolve that import;
it says nothing about the real API. Delete it once the Python SDK ships and check the samples
against the real package instead.
"""

from typing import Any

def expect(target: Any) -> Any: ...
