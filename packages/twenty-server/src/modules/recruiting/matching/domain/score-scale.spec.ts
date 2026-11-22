/** Proves rubric points and rerank relevance are never placed on one numeric axis. */
import {
  compareRecruitingScores,
  recommendationPool,
  recruitingScoreNotice,
} from './score-scale';

const jev = {
  status: 'SCORED',
  scoreKind: 'jev-rubric',
  score: 3.2,
  probabilities: { '3': 0.8 },
  confidence: 0.5,
};
const rerank = {
  status: 'SCORED',
  scoreKind: 'qwen3-rerank-relevance',
  relevanceScore: 0.8,
};

describe('recruiting score scales', () => {
  it('does not subtract a relevance score from a rubric score', () => {
    expect(compareRecruitingScores(jev, rerank)).not.toBeCloseTo(3.2 - 0.8);
    expect(
      compareRecruitingScores(rerank, { ...rerank, relevanceScore: 0.2 }),
    ).toBeLessThan(0);
    expect(compareRecruitingScores(jev, { ...jev, score: 1 })).toBeLessThan(0);
  });

  it('keeps historical JEV rows out of a mixed recommendation order', () => {
    expect(recommendationPool([jev, rerank])).toEqual([rerank]);
    expect(recommendationPool([jev])).toEqual([jev]);
    expect(recruitingScoreNotice([jev, rerank])).toContain('不能互相比较');
    expect(recruitingScoreNotice([jev])).toContain('历史 JEV');
    expect(recruitingScoreNotice([rerank])).toContain('不是 0–4');
  });
});
