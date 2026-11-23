"""Credentials from the environment: `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`."""

import os
import re
from collections.abc import Mapping

_FIELD = re.compile(r"\{(\w+)\}")


def _env_name(value: object) -> str:
    """A name as it appears in an environment variable: "Ana" -> "ANA", "ana-smith" -> "ANA_SMITH"."""
    return re.sub(r"[^A-Z0-9]+", "_", str(value).upper())


def credential(template: str, values: Mapping[str, object]) -> str | None:
    """A credential from the environment, when a test leaves it out.

    "CHANNELSTACK_SLACK_USER_{name}_TOKEN" with {"name": "Ana"} reads
    CHANNELSTACK_SLACK_USER_ANA_TOKEN. Unset (or empty), it is None, and the object is fake.
    So one test runs fake on every PR and live where the variables are set.
    """
    if any(values.get(field) is None for field in _FIELD.findall(template)):
        return None
    variable = _FIELD.sub(lambda match: _env_name(values[match.group(1)]), template)
    return os.environ.get(variable) or None
