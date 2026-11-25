"""The run's settings: the plugin sets them from the command line and the ini file, the helpers read them."""

from dataclasses import dataclass

from channelstack.runtime.duration import Duration
from channelstack.runtime.launcher import Mode


@dataclass
class Defaults:
    mode: Mode = "auto"
    """How the session's client finds the server: attach to one, start one, or either (`auto`)."""
    timeout: Duration = "10s"
    """How long a positive check polls, and a negative one waits for quiet."""
    quiet_for: Duration = "750ms"
    """How long the agent must be quiet before a negative or exact-count check reads."""


defaults = Defaults()
