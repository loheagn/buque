from buque.core.config import ScoreWeights
from buque.core.scorer import infer_numbered_level, total_score


def test_total_score_uses_fixed_weights() -> None:
    weights = ScoreWeights(style=0.45, position=0.2, pattern=0.25, semantic=0.1)
    score = total_score(
        weights=weights,
        style=0.8,
        position=0.5,
        pattern=1.0,
        semantic=0.2,
    )
    assert round(score, 4) == round(0.45 * 0.8 + 0.2 * 0.5 + 0.25 * 1.0 + 0.1 * 0.2, 4)


def test_numbered_level_inference() -> None:
    assert infer_numbered_level("Chapter 2 Data Pipeline") == 1
    assert infer_numbered_level("第3章 测试策略") == 1
    assert infer_numbered_level("第2节 背景") == 2
    assert infer_numbered_level("1.2.3 Storage") == 3
    assert infer_numbered_level("random body text") is None
