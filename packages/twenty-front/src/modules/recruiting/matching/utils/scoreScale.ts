/** Shows each stored scale in its own words. Relevance is never printed as a score out of 4. */

export const formatRecruitingMatchValue = (pair: {
  score?: number;
  relevanceScore?: number;
  scoreKind?: string;
}) => {
  if (
    pair.scoreKind === 'qwen3-rerank-relevance' &&
    typeof pair.relevanceScore === 'number' &&
    Number.isFinite(pair.relevanceScore)
  ) {
    return {
      primary: `相关度 ${pair.relevanceScore.toFixed(3)}`,
      note: 'Qwen3 重排相关度，不是五档能力分，不能与 JEV 分数比较',
    };
  }
  if (typeof pair.score === 'number' && Number.isFinite(pair.score)) {
    return {
      primary: `${pair.score.toFixed(2)} / 4`,
      note: 'JEV 五档期望分，不能与重排相关度比较',
    };
  }
  return { primary: '', note: '' };
};

/** Sorts inside one scale. A rubric point and a relevance score are not subtracted. */
export const compareDisplayedScores = (
  left: { score?: number; relevanceScore?: number; scoreKind?: string },
  right: { score?: number; relevanceScore?: number; scoreKind?: string },
) => {
  const kind = (pair: {
    score?: number;
    relevanceScore?: number;
    scoreKind?: string;
  }) =>
    pair.scoreKind === 'qwen3-rerank-relevance' ||
    (pair.scoreKind === undefined && typeof pair.relevanceScore === 'number')
      ? 'qwen3-rerank-relevance'
      : 'jev-rubric';
  if (kind(left) !== kind(right)) return kind(left) < kind(right) ? -1 : 1;
  const value = (pair: {
    score?: number;
    relevanceScore?: number;
    scoreKind?: string;
  }) =>
    kind(pair) === 'qwen3-rerank-relevance' ? pair.relevanceScore : pair.score;
  return (value(right) ?? -1) - (value(left) ?? -1);
};
