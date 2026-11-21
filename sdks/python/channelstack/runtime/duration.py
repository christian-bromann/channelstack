"""Durations: milliseconds as a number, or "250ms", "3s", "1m"."""

import math
import re

Duration = float | str

_UNITS = {"ms": 1.0, "s": 1000.0, "m": 60_000.0}
_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)(ms|s|m)$")


def parse_duration(duration: Duration) -> float:
    """A duration in milliseconds."""
    if isinstance(duration, str):
        match = _PATTERN.match(duration)
        if match is None:
            raise ValueError(f'Not a duration: "{duration}". Use milliseconds, or "250ms", "3s", "1m".')
        return float(match.group(1)) * _UNITS[match.group(2)]
    if not math.isfinite(duration) or duration < 0:
        raise ValueError(f"Not a duration: {duration}")
    return float(duration)
