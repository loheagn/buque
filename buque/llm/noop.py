from __future__ import annotations

from typing import Any


class NoopLLMResolver:
    """M1 placeholder resolver for LLM calls."""

    def resolve(self, *, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return candidates
