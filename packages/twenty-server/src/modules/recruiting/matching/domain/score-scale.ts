/** Keeps JEV rubric scores and Qwen rerank relevance from being treated as one number. */

export const JEV_RUBRIC = 'jev-rubric';
export const QWEN_RERANK = 'qwen3-rerank-relevance';

export type ScoreCarrier = {
  status?: string;
  score?: number;
  relevanceScore?: number;
  scoreKind?: string;
  probabilities?: unknown;
  confidence?: unknown;
  modelId?: string;
};

/** Classifies stored rows, including historical payloads that predate scoreKind. */
export const scoreKindOf = (row: ScoreCarrier) => {
  if (row.scoreKind === QWEN_RERANK || row.scoreKind === JEV_RUBRIC)
    return row.scoreKind;
  if (
    row.modelId?.includes('jev') ||
    row.probabilities !== undefined ||
    typeof row.confidence === 'number'
  )
    return JEV_RUBRIC;
  if (typeof row.relevanceScore === 'number') return QWEN_RERANK;
  if (typeof row.score === 'number') return JEV_RUBRIC;
  return 'unscored';
};

const nativeRank = (row: ScoreCarrier) => {
  const kind = scoreKindOf(row);
  if (kind === QWEN_RERANK)
    return typeof row.relevanceScore === 'number' &&
      Number.isFinite(row.relevanceScore)
      ? row.relevanceScore
      : undefined;
  if (kind === JEV_RUBRIC)
    return typeof row.score === 'number' && Number.isFinite(row.score)
      ? row.score
      : undefined;
  return undefined;
};

/** Orders one scale. Different scales are grouped and their numbers are never subtracted. */
export const compareRecruitingScores = (
  left: ScoreCarrier,
  right: ScoreCarrier,
) => {
  const leftKind = scoreKindOf(left);
  const rightKind = scoreKindOf(right);
  if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
  return (nativeRank(right) ?? -1) - (nativeRank(left) ?? -1);
};

/** Uses only the current rerank scale when a stored run also contains historical JEV scores. */
export const recommendationPool = <TRow extends ScoreCarrier>(rows: TRow[]) => {
  const scored = rows.filter((row) => row.status === 'SCORED');
  const kinds = new Set(scored.map(scoreKindOf));
  if (kinds.has(QWEN_RERANK) && kinds.has(JEV_RUBRIC))
    return scored.filter((row) => scoreKindOf(row) === QWEN_RERANK);
  return scored;
};

/** Describes the scale that a reader is looking at. */
export const recruitingScoreNotice = (rows: ScoreCarrier[]) => {
  const kinds = new Set(
    rows.filter((row) => row.status === 'SCORED').map(scoreKindOf),
  );
  const hasJev = kinds.has(JEV_RUBRIC);
  const hasRerank = kinds.has(QWEN_RERANK);
  if (hasJev && hasRerank)
    return '这份结果同时有 JEV 五档期望分和 Qwen3 重排相关度。两种数字不能互相比较，推荐顺序只使用同一种。';
  if (hasRerank)
    return '推荐顺序是同一次 Qwen3 重排相关度，不是 0–4 档能力分，不能与历史 JEV 分数比较。意向和未知条件仍需人工确认。';
  if (hasJev)
    return '这些是历史 JEV 五档期望分，不是 Qwen3 重排相关度，不能与新的相关度互相比较。意向和未知条件仍需人工确认。';
  return '意向和未知条件需人工确认，不能直接作为录用或推荐决定。';
};
