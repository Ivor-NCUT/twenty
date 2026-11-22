/** Verifies rerank billing boundaries, index binding and safe failure persistence without network calls. */
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { type RecruitingRecordsService } from '../records/records.service';
import {
  RerankCallError,
  type SiliconflowRerankClient,
} from './domain/siliconflow-rerank';
import {
  RecruitingEvaluationAuthError,
  RecruitingPairEvaluatorService,
  type RecruitingPairResult,
} from './pair-evaluator.service';

const context = { workspace: { id: 'workspace' } } as WorkspaceAuthContext;
const candidate = {
  id: 'candidate',
  recruitingProfile: { summary: '维护 TypeScript 服务' },
};
const job = {
  id: 'job',
  name: '后端',
  jobStatus: 'RECRUITING',
  jobAttributes: ['FULL_TIME'],
  jobDescription: { markdown: '维护 TypeScript 服务' },
};
const company = {
  id: 'company',
  name: '公司',
  recruitingDescription: '基础设施',
};

const success = (documents: readonly string[]) => ({
  assignments: new Map(
    documents.map((_, index) => [index, { relevanceScore: 0.8 }]),
  ),
  failures: new Map<number, string>(),
  usage: { inputTokens: 100, outputTokens: 1 },
});

const setup = () => {
  const rows = new Map<string, Record<string, unknown>>();
  const records = {
    one: jest.fn(async (_context, _object, id: string) => {
      if (!rows.has(id)) throw new NotFoundException();
      return rows.get(id)!;
    }),
    byIds: jest.fn(
      async (_context, _object, ids: string[]) =>
        new Map(
          ids.filter((id) => rows.has(id)).map((id) => [id, rows.get(id)!]),
        ),
    ),
    create: jest.fn(
      async (
        _context,
        _object,
        data: Record<string, unknown> & { id: string },
      ) => {
        if (rows.has(data.id)) throw new Error('duplicate');
        rows.set(data.id, structuredClone(data));
        return data;
      },
    ),
    update: jest.fn(
      async (_context, _object, id: string, data: Record<string, unknown>) => {
        const next = { ...rows.get(id), ...structuredClone(data) };
        rows.set(id, next);
        return next;
      },
    ),
  };
  const locks = {
    tryWithLock: async (_name: string, callback: () => Promise<unknown>) => ({
      acquired: true,
      value: await callback(),
    }),
  };
  const rerank = {
    rerank: jest.fn(async (_query: string, documents: readonly string[]) =>
      success(documents),
    ) as jest.Mock,
  };
  const evaluator = new RecruitingPairEvaluatorService(
    records as unknown as RecruitingRecordsService,
    locks as unknown as PostgresAdvisoryLockService,
    rerank as unknown as SiliconflowRerankClient,
  );
  return { evaluator, rows, records, rerank };
};

describe('recruiting pair evaluator', () => {
  it('stores native relevance and reuses it without inventing a rubric score', async () => {
    const { evaluator, rows, rerank } = setup();
    const first = await evaluator.run(context, candidate, job, company);
    const cached = await evaluator.run(context, candidate, job, company);
    expect(first.relevanceScore).toBe(0.8);
    expect(first.score).toBeUndefined();
    expect(first.probabilities).toBeUndefined();
    expect(first.confidence).toBeUndefined();
    expect(first.scoreKind).toBe('qwen3-rerank-relevance');
    expect(first.relevanceScore).not.toBe(3.2);
    expect(cached.cached).toBe(true);
    expect(rerank.rerank).toHaveBeenCalledTimes(1);
    const stored = [...rows.values()][0];
    expect(stored.score).toBeNull();
    expect(JSON.stringify(stored.payload)).not.toContain('probabilities');
    expect(JSON.stringify(stored.payload)).not.toContain('confidence');
  });

  it('invalidates the pair when company context changes', async () => {
    const { evaluator, rerank } = setup();
    const first = await evaluator.run(context, candidate, job, company);
    const changed = await evaluator.run(context, candidate, job, {
      ...company,
      recruitingDescription: '金融系统',
    });
    expect(changed.cacheId).not.toBe(first.cacheId);
    expect(rerank.rerank).toHaveBeenCalledTimes(2);
  });

  it('keeps a historical JEV cache key distinct from the rerank identity', () => {
    const { evaluator } = setup();
    const current = evaluator.prepare(
      context,
      candidate,
      job,
      company,
    ).cacheKey;
    const historical = evaluator.cacheKeyForModel(
      context,
      candidate,
      job,
      company,
      'typesafe-ai/jev-latest',
    );
    expect(historical).not.toBe(current);
    expect(
      evaluator.cacheKeyForModel(
        context,
        candidate,
        job,
        company,
        'typesafe-ai/jev-latest',
      ),
    ).toBe(historical);
  });

  it('updates an expired rerank snapshot instead of creating a second row', async () => {
    const { evaluator, rows, records, rerank } = setup();
    const first = await evaluator.run(context, candidate, job, company);
    (rows.get(first.cacheId)!.payload as RecruitingPairResult).evaluatedAt =
      new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect((await evaluator.run(context, candidate, job, company)).cached).toBe(
      false,
    );
    expect(records.create).toHaveBeenCalledTimes(1);
    expect(rerank.rerank).toHaveBeenCalledTimes(2);
  });

  it('filters an explicit conflict before any model call or cache write', async () => {
    const { evaluator, records, rerank } = setup();
    const result = await evaluator.run(
      context,
      {
        ...candidate,
        candidatePreferences: {
          markdown: '这是测试候选人，只考虑全职后端开发，不考虑实习岗位。',
        },
      },
      { ...job, jobAttributes: ['INTERNSHIP'] },
      company,
    );
    expect(result.status).toBe('EXCLUDED');
    expect(result.relevanceScore).toBeUndefined();
    expect(result.score).toBeUndefined();
    expect(rerank.rerank).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
  });

  it('checks native write permission before calling the provider', async () => {
    const { evaluator, records, rerank } = setup();
    records.create.mockRejectedValue(new ForbiddenException());
    await expect(
      evaluator.run(context, candidate, job, company),
    ).rejects.toThrow(ForbiddenException);
    expect(rerank.rerank).not.toHaveBeenCalled();
  });

  it('does not truncate oversized material or score an empty identity', async () => {
    const { evaluator, rerank } = setup();
    expect(
      (await evaluator.run(context, { id: 'empty' }, job, company)).status,
    ).toBe('NEEDS_REVIEW');
    expect(
      (
        await evaluator.run(
          context,
          {
            id: 'large',
            recruitingProfile: { sourceText: '职业经历'.repeat(100_000) },
          },
          job,
          company,
        )
      ).status,
    ).toBe('NEEDS_REVIEW');
    expect(rerank.rerank).not.toHaveBeenCalled();
  });

  it('sends the complete non-ASCII resume to the documented rerank fields', async () => {
    const { evaluator, rerank } = setup();
    const text = '职业经历和具体项目。'.repeat(2000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(32_000);
    const result = await evaluator.run(
      context,
      { id: 'long', recruitingProfile: { sourceText: text } },
      job,
      company,
    );
    expect(result.status).toBe('SCORED');
    expect(result.longContext).toBe(true);
    const documents = rerank.rerank.mock.calls[0][1];
    expect(documents[0]).toContain(text);
    expect(
      documents[0].endsWith(text.slice(-20)) || documents[0].includes(text),
    ).toBe(true);
  });

  it('reports a provider context rejection without a zero score or the response body', async () => {
    const { evaluator, rows, rerank } = setup();
    rerank.rerank.mockRejectedValue(new RerankCallError('context'));
    const result = await evaluator.run(context, candidate, job, company);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.relevanceScore).toBeUndefined();
    expect(result.score).toBeUndefined();
    expect(JSON.stringify([...rows.values()])).not.toContain(
      'private material',
    );
  });

  it('persists an authorization failure without a secret or a zero score', async () => {
    const { evaluator, rows, rerank } = setup();
    rerank.rerank.mockRejectedValue(new RerankCallError('auth'));
    await expect(
      evaluator.run(context, candidate, job, company),
    ).rejects.toThrow(RecruitingEvaluationAuthError);
    const record = [...rows.values()][0];
    expect(record.status).toBe('FAILED');
    expect(record.score).toBeNull();
    expect(JSON.stringify(record)).not.toContain('secret');
    expect(JSON.stringify(record)).not.toContain('SILICONFLOW_API_KEY');
  });

  it('does not retry a context rejection by shortening the same resume', async () => {
    const { evaluator, rerank } = setup();
    rerank.rerank.mockRejectedValue(new RerankCallError('context'));
    await evaluator.run(context, candidate, job, company);
    expect(rerank.rerank).toHaveBeenCalledTimes(1);
    expect(rerank.rerank.mock.calls[0][1][0].length).toBeGreaterThan(10);
  });

  it('binds a reversed batch response by index and echoed text', async () => {
    const { evaluator, rerank } = setup();
    rerank.rerank.mockImplementation(
      async (_query: string, documents: readonly string[]) => ({
        assignments: new Map([
          [1, { relevanceScore: 0.2 }],
          [0, { relevanceScore: 0.9 }],
        ]),
        failures: new Map<number, string>(),
      }),
    );
    const other = {
      id: 'other',
      recruitingProfile: { summary: '另一位候选人的独立经历' },
    };
    const { rows } = await evaluator.scoreChunk(context, [
      { candidate, job, company },
      { candidate: other, job, company },
    ]);
    expect(rows.map((row) => [row.candidateId, row.relevanceScore])).toEqual([
      ['candidate', 0.9],
      ['other', 0.2],
    ]);
    expect(rerank.rerank).toHaveBeenCalledTimes(1);
    expect(rerank.rerank.mock.calls[0][1]).toHaveLength(2);
  });

  it('drops a mismatched document instead of assigning that score to someone else', async () => {
    const { evaluator, rerank } = setup();
    rerank.rerank.mockResolvedValue({
      assignments: new Map(),
      failures: new Map([[0, '响应文档与请求索引不一致，未采用该相关度']]),
    });
    const result = await evaluator.run(context, candidate, job, company);
    expect(result.status).toBe('FAILED');
    expect(result.relevanceScore).toBeUndefined();
    expect(result.score).toBeUndefined();
    expect(result.error).toContain('索引');
  });

  it('rejects an empty or illegal provider score without storing zero', async () => {
    const { evaluator, rerank, rows } = setup();
    rerank.rerank.mockResolvedValueOnce({
      assignments: new Map(),
      failures: new Map([[0, '重排响应没有可用结果，未记为零分']]),
    });
    const empty = await evaluator.run(context, candidate, job, company);
    expect(empty.status).toBe('FAILED');
    expect(empty.relevanceScore).toBeUndefined();
    rerank.rerank.mockResolvedValueOnce({
      assignments: new Map(),
      failures: new Map([[0, '相关度无效，未换算成能力分']]),
    });
    const illegal = await evaluator.run(context, candidate, job, company);
    expect(illegal.relevanceScore).toBeUndefined();
    expect(JSON.stringify([...rows.values()])).not.toContain(
      '"relevanceScore"',
    );
  });
});

it('batch-reuses only a current unexpired relevance score', async () => {
  const { evaluator, records, rows, rerank } = setup();
  const first = await evaluator.run(context, candidate, job, company);
  records.one.mockClear();
  const reused = await evaluator.reusePool(context, [candidate], job, company);
  expect(reused.get(candidate.id)).toMatchObject({
    relevanceScore: first.relevanceScore,
    cached: true,
  });
  expect(records.byIds).toHaveBeenCalledTimes(1);
  expect(records.one).not.toHaveBeenCalled();
  expect(rerank.rerank).toHaveBeenCalledTimes(1);
  const stored = [...rows.values()][0];
  (stored.payload as RecruitingPairResult).evaluatedAt = '2000-01-01T00:00:00Z';
  expect(
    (await evaluator.reusePool(context, [candidate], job, company)).size,
  ).toBe(0);
  expect(rerank.rerank).toHaveBeenCalledTimes(1);
});
