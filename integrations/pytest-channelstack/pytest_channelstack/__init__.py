"""pytest-channelstack: fixtures and `expect(...)` checks for testing AI agents.

For agents in Slack, GitHub, Linear, Notion, email and Discord, and their model on OpenAI.
"""

from .matchers import Expectation, expect

__all__ = ["Expectation", "expect"]
