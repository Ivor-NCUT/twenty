/** Keeps the workbench from printing rerank relevance as a five-level ability score. */
import {
  compareDisplayedScores,
  formatRecruitingMatchValue,
} from '@/recruiting/matching/utils/scoreScale';

it('prints a historical JEV expectation out of 4', () => {
  expect(formatRecruitingMatchValue({ score: 3.2 })).toEqual({
    primary: '3.20 / 4',
    note: 'JEV 五档期望分，不能与重排相关度比较',
  });
});

it('prints Qwen relevance without multiplying it into the old rubric', () => {
  const formatted = formatRecruitingMatchValue({
    scoreKind: 'qwen3-rerank-relevance',
    relevanceScore: 0.8,
  });
  expect(formatted.primary).toBe('相关度 0.800');
  expect(formatted.primary).not.toContain('/ 4');
  expect(formatted.note).toContain('不能与 JEV 分数比较');
  expect(
    compareDisplayedScores(
      { score: 3.2 },
      { scoreKind: 'qwen3-rerank-relevance', relevanceScore: 0.8 },
    ),
  ).not.toBeCloseTo(2.4);
});
