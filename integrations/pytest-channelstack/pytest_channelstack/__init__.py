"""pytest-channelstack: fixtures and `expect(...)` checks for testing AI agents in Slack, GitHub, Linear and Notion."""

from .matchers import Expectation, expect

__all__ = ["Expectation", "expect"]
