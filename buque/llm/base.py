from __future__ import annotations

from typing import Any, Protocol


class LLMResolver(Protocol):
    def resolve(self, *, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Resolve low-confidence candidate headings."""
