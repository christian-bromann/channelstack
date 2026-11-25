"""The run's settings: the plugin sets them from the command line and the ini file, the helpers read them."""

from dataclasses import dataclass

from channelstack.runtime.launcher import Mode


@dataclass
class Defaults:
    mode: Mode = "auto"
    """How the session's client finds the server: attach to one, start one, or either (`auto`)."""


defaults = Defaults()
