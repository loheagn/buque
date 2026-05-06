from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

try:
    from importlib.resources import files
except ImportError:  # pragma: no cover
    from importlib_resources import files  # type: ignore


class ScoreWeights(BaseModel):
    style: float = 0.45
    position: float = 0.2
    pattern: float = 0.25
    semantic: float = 0.1


class Thresholds(BaseModel):
    high: float = 0.68
    text_ratio_high: float = 0.8
    text_ratio_low: float = 0.2
    min_text_chars_per_page: int = 20
    max_level_jump: int = 1


class RuleConfig(BaseModel):
    min_line_chars: int = 2
    max_line_chars: int = 120
    min_style_candidate: float = 0.35
    min_pattern_candidate: float = 0.5
    min_semantic_candidate: float = 0.5
    max_candidates_per_page: int = 80


class AppConfig(BaseModel):
    score_weights: ScoreWeights = Field(default_factory=ScoreWeights)
    thresholds: Thresholds = Field(default_factory=Thresholds)
    rules: RuleConfig = Field(default_factory=RuleConfig)


def load_config(config_path: Path | None = None) -> AppConfig:
    if config_path is None:
        config_path = Path(str(files("buque.configs").joinpath("default.yaml")))
    raw: dict[str, Any] = {}
    if config_path.exists():
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    return AppConfig.model_validate(raw)
