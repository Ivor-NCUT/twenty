import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { v5 } from 'uuid';

import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { RECRUITING_ADVISORY_LOCK } from '../shared/locking/advisory-lock.constant';
import { RecruitingRecordsService } from '../records/records.service';
import {
  buildCandidateMatchContext,
  buildJobMatchContext,
  stableSerialize,
  type MatchSource,
} from './domain/match-context';
import {
  evaluateRecruitingEligibility,
  getPairEvaluationCacheKey,
  type EligibilityResult,
} from './domain/match-policy';
import { RECRUITING_MATCH_PROTOCOL } from './domain/match-protocol';
import {
  RERANK_INSTRUCTION_ID,
  RERANK_MODEL_ID,
  RERANK_MODEL_VERSION,
  RERANK_SCORE_KIND,
  RerankCallError,
  RerankPayloadTooLargeError,
  SiliconflowRerankClient,
  buildRerankRequest,
} from './domain/siliconflow-rerank';

/** Stops a run after upstream authorization fails without exposing provider response contents. */
export class RecruitingEvaluationAuthError extends Error {
  constructor() {
    super('硅基流动授权不可用，请管理员配置 SILICONFLOW_API_KEY');
  }
}

type PreparedPair = {
  candidate: ReturnType<typeof buildCandidateMatchContext>;
  job: ReturnType<typeof buildJobMatchContext>;
  modelId: string;
  instructionId: string;
  cacheKey: string;
  cacheId: string;
};

/** A failure has no score. Relevance is not stored in the historical 0–4 ability field. */
export type RecruitingPairResult = {
  candidateId: string;
  longContext?: boolean;
  jobId: string;
  candidateLabel: string;
  jobLabel: string;
  companyId?: string;
  status: 'SCORED' | 'EXCLUDED' | 'NEEDS_REVIEW' | 'FAILED';
  protocolVersion?: string;
  eligibility: EligibilityResult;
  intent?: {
    expectedRoles: string[];
    status: 'declared' | 'unspecified';
    requiresConfirmation: boolean;
  };
  score?: number;
  scoreKind?: typeof RERANK_SCORE_KIND | 'jev-rubric';
  relevanceScore?: number;
  instructionId?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  error?: string;
  cacheId: string;
  cacheKey: string;
  cached: boolean;
  evaluatedAt: string;
  modelId: string;
  resolvedModelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  cost?: string | number;
  elapsedMs?: number;
  duplicateKey: string;
};

type PendingPair = {
  prepared: PreparedPair;
  base: RecruitingPairResult;
  query: string;
  document: string;
  result?: RecruitingPairResult;
};

const LONG_MATERIAL_CHARS = 20_000;

@Injectable()
/** Shares one pair cache across directions and sends resumes to the reranker without truncating them. */
export class RecruitingPairEvaluatorService {
  private readonly rerank: SiliconflowRerankClient;

  constructor(
    private readonly records: RecruitingRecordsService,
    @Inject(RECRUITING_ADVISORY_LOCK)
    private readonly locks: PostgresAdvisoryLockService,
    @Optional() rerank?: SiliconflowRerankClient,
  ) {
    this.rerank = rerank ?? new SiliconflowRerankClient();
  }

  /** Rerank has no configured token price; a missing price is not reported as zero. */
  inputPricePerMillion() {
    return null;
  }

  /** Computes eligibility and a content-only cache identity without calling the provider. */
  prepare(
    context: WorkspaceAuthContext,
    candidateRecord: MatchSource,
    jobRecord: MatchSource,
    companyRecord?: MatchSource,
  ): PreparedPair {
    return this.prepared(
      context,
      candidateRecord,
      jobRecord,
      companyRecord,
      RERANK_MODEL_VERSION,
      RERANK_MODEL_ID,
      RERANK_INSTRUCTION_ID,
    );
  }

  /** Rebuilds the cache identity a stored row was hashed with, so a model change does not hide it. */
  cacheKeyForModel(
    context: WorkspaceAuthContext,
    candidateRecord: MatchSource,
    jobRecord: MatchSource,
    companyRecord: MatchSource | undefined,
    modelId: string,
    instructionId?: string,
  ) {
    return this.prepared(
      context,
      candidateRecord,
      jobRecord,
      companyRecord,
      instructionId ? `${modelId}@${instructionId}` : modelId,
      modelId,
      instructionId,
    ).cacheKey;
  }

  /** Reuses a complete current-model snapshot. Historical JEV rows live under a different identity. */
  async reusePool(
    context: WorkspaceAuthContext,
    candidates: MatchSource[],
    jobRecord: MatchSource,
    companyRecord?: MatchSource,
  ) {
    const prepared = candidates.map((candidate) =>
      this.prepare(context, candidate, jobRecord, companyRecord),
    );
    const cached = await this.records.byIds(
      context,
      'recruitingPairEvaluation',
      prepared.map((pair) => pair.cacheId),
    );
    const results = new Map<string, RecruitingPairResult>();
    for (const pair of prepared) {
      const { candidate, job, cacheId, cacheKey, modelId } = pair;
      const eligibility = evaluateRecruitingEligibility(
        candidate.eligibility,
        job.eligibility,
      );
      if (eligibility.status === 'excluded') {
        results.set(candidate.id, {
          candidateId: candidate.id,
          jobId: job.id,
          candidateLabel: candidate.label,
          jobLabel: job.label,
          companyId: job.companyId,
          status: 'EXCLUDED',
          eligibility,
          cacheId,
          cacheKey,
          modelId,
          instructionId: pair.instructionId,
          scoreKind: RERANK_SCORE_KIND,
          cached: false,
          evaluatedAt: new Date().toISOString(),
          duplicateKey: job.duplicateKey,
          protocolVersion: RECRUITING_MATCH_PROTOCOL.version,
        });
        continue;
      }
      if (candidate.issue || job.issue) continue;
      const payload = cached.get(cacheId)?.payload as
        | RecruitingPairResult
        | undefined;
      if (this.reusable(payload, cacheKey))
        results.set(candidate.id, {
          ...payload!,
          candidateLabel: candidate.label,
          jobLabel: job.label,
          cached: true,
        });
    }
    return results;
  }

  /** Scores one pair. Authorization failure still throws so a caller can stop a run. */
  async run(
    context: WorkspaceAuthContext,
    candidateRecord: MatchSource,
    jobRecord: MatchSource,
    companyRecord?: MatchSource,
  ) {
    const outcome = await this.scoreChunk(context, [
      { candidate: candidateRecord, job: jobRecord, company: companyRecord },
    ]);
    if (outcome.authorizationFailed) throw new RecruitingEvaluationAuthError();
    return outcome.rows[0];
  }

  /** Reranks documents that share one job query. Each response index is checked against that document. */
  async scoreChunk(
    context: WorkspaceAuthContext,
    triples: {
      candidate: MatchSource;
      job: MatchSource;
      company?: MatchSource;
    }[],
  ) {
    const slots: Array<RecruitingPairResult | PendingPair> = [];
    for (const triple of triples) {
      const prepared = this.prepare(
        context,
        triple.candidate,
        triple.job,
        triple.company,
      );
      const local = this.localDecision(prepared);
      if (local.done) {
        slots.push(local.result);
        continue;
      }
      const cached = await this.cached(
        context,
        prepared.cacheId,
        prepared.cacheKey,
      );
      if (cached) {
        slots.push({
          ...cached,
          eligibility: local.base.eligibility,
          cached: true,
        });
        continue;
      }
      slots.push({
        prepared,
        base: local.base,
        query: stableSerialize({
          job: prepared.job.context,
          company: prepared.job.company,
        }),
        document: stableSerialize({ resume: prepared.candidate.context }),
      });
    }
    let authorizationFailed = false;
    const groups = new Map<string, PendingPair[]>();
    for (const slot of slots) {
      if (!this.isPending(slot)) continue;
      const group = groups.get(slot.query) ?? [];
      group.push(slot);
      groups.set(slot.query, group);
    }
    for (const group of groups.values()) {
      if (authorizationFailed) {
        group.forEach((item) => {
          item.result = this.failed(item.base, 'auth');
        });
        continue;
      }
      try {
        await this.scoreGroup(context, group);
      } catch (error) {
        if (error instanceof RecruitingEvaluationAuthError)
          authorizationFailed = true;
        else throw error;
      }
    }
    return {
      rows: slots.map((slot) =>
        this.isPending(slot)
          ? (slot.result ?? this.failed(slot.base, 'busy'))
          : slot,
      ),
      authorizationFailed,
    };
  }

  private isPending(
    slot: RecruitingPairResult | PendingPair,
  ): slot is PendingPair {
    return 'prepared' in slot;
  }

  private prepared(
    context: WorkspaceAuthContext,
    candidateRecord: MatchSource,
    jobRecord: MatchSource,
    companyRecord: MatchSource | undefined,
    modelVersion: string,
    modelId: string,
    instructionId?: string,
  ): PreparedPair {
    const candidate = buildCandidateMatchContext(candidateRecord);
    const job = buildJobMatchContext(jobRecord, companyRecord);
    const cacheKey = getPairEvaluationCacheKey({
      workspaceId: context.workspace.id,
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      jobId: job.id,
      jobVersion: job.version,
      companyVersion: job.companyVersion,
      protocolVersion: RECRUITING_MATCH_PROTOCOL.abilityCacheNamespace,
      modelVersion,
    });
    return {
      candidate,
      job,
      modelId,
      instructionId: instructionId ?? '',
      cacheKey,
      cacheId: v5(`${context.workspace.id}:${cacheKey}`, v5.URL),
    };
  }

  private localDecision(prepared: PreparedPair) {
    const { candidate, job, modelId, cacheKey, cacheId, instructionId } =
      prepared;
    const eligibility = evaluateRecruitingEligibility(
      candidate.eligibility,
      job.eligibility,
    );
    if (candidate.supplementOnly) {
      eligibility.reasons.push({
        code: 'supplement_only',
        message: '目前只有投递自述或补充说明，原始简历需补充或核实',
        blocking: false,
      });
      if (eligibility.status === 'eligible')
        eligibility.status = 'needs_confirmation';
    }
    const base: RecruitingPairResult = {
      protocolVersion: RECRUITING_MATCH_PROTOCOL.version,
      candidateId: candidate.id,
      jobId: job.id,
      candidateLabel: candidate.label,
      jobLabel: job.label,
      companyId: job.companyId,
      status: 'NEEDS_REVIEW',
      eligibility,
      intent: {
        expectedRoles: candidate.context.expectedRoles,
        status: candidate.context.expectedRoles.length
          ? 'declared'
          : 'unspecified',
        requiresConfirmation: true,
      },
      cacheId,
      cacheKey,
      cached: false,
      evaluatedAt: new Date().toISOString(),
      modelId,
      instructionId,
      scoreKind: RERANK_SCORE_KIND,
      duplicateKey: job.duplicateKey,
    };
    if (eligibility.status === 'excluded')
      return {
        done: true as const,
        result: { ...base, status: 'EXCLUDED' as const },
        base,
      };
    if (candidate.issue || job.issue)
      return {
        done: true as const,
        result: { ...base, error: candidate.issue ?? job.issue },
        base,
      };
    return { done: false as const, base };
  }

  private async scoreGroup(
    context: WorkspaceAuthContext,
    group: PendingPair[],
  ) {
    try {
      buildRerankRequest(
        group[0].query,
        group.map((item) => item.document),
      );
    } catch (error) {
      if (error instanceof RerankPayloadTooLargeError && group.length > 1) {
        const middle = Math.ceil(group.length / 2);
        await this.scoreGroup(context, group.slice(0, middle));
        await this.scoreGroup(context, group.slice(middle));
        return;
      }
      if (error instanceof RerankPayloadTooLargeError) {
        group.forEach((item) => {
          item.result = {
            ...item.base,
            error: '完整材料超过请求体积上限，未截断；请先整理或拆分材料',
          };
        });
        return;
      }
      throw error;
    }
    let splitAfter: PendingPair[] | undefined;
    const locked = await this.lockAll(context, group, async () => {
      const billable: PendingPair[] = [];
      for (const item of group) {
        const current = await this.cached(
          context,
          item.prepared.cacheId,
          item.prepared.cacheKey,
        );
        if (current) {
          item.result = {
            ...current,
            eligibility: item.base.eligibility,
            cached: true,
          };
          continue;
        }
        await this.claim(context, item);
        billable.push(item);
      }
      if (!billable.length) return;
      const started = performance.now();
      let bound;
      try {
        bound = await this.rerank.rerank(
          billable[0].query,
          billable.map((item) => item.document),
        );
      } catch (error) {
        if (
          error instanceof RerankCallError &&
          error.kind === 'context' &&
          billable.length > 1
        ) {
          splitAfter = billable;
          return;
        }
        await this.recordCallFailure(context, billable, error);
        if (error instanceof RerankCallError && error.kind === 'auth')
          throw new RecruitingEvaluationAuthError();
        return;
      }
      const elapsedMs = Math.round(performance.now() - started);
      for (let index = 0; index < billable.length; index++) {
        const item = billable[index];
        const assignment = bound.assignments.get(index);
        if (!assignment) {
          await this.persist(context, item, {
            ...item.base,
            status: 'FAILED',
            error:
              bound.failures.get(index) ??
              '重排响应无法对应到该候选人，未记为零分',
          });
          continue;
        }
        const longMaterial =
          item.query.length > LONG_MATERIAL_CHARS ||
          item.document.length > LONG_MATERIAL_CHARS;
        await this.persist(context, item, {
          ...item.base,
          status: 'SCORED',
          scoreKind: RERANK_SCORE_KIND,
          relevanceScore: assignment.relevanceScore,
          ...(longMaterial ? { longContext: true } : {}),
          ...(billable.length === 1 && bound.usage
            ? { usage: bound.usage }
            : {}),
          elapsedMs,
        });
      }
    });
    if (!locked) {
      group.forEach((item) => {
        item.result ??= this.failed(item.base, 'busy');
      });
      return;
    }
    if (splitAfter) {
      const middle = Math.ceil(splitAfter.length / 2);
      await this.scoreGroup(context, splitAfter.slice(0, middle));
      await this.scoreGroup(context, splitAfter.slice(middle));
    }
  }

  private async recordCallFailure(
    context: WorkspaceAuthContext,
    items: PendingPair[],
    error: unknown,
  ) {
    const kind = error instanceof RerankCallError ? error.kind : 'unavailable';
    for (const item of items) {
      if (kind === 'context') {
        await this.persist(context, item, {
          ...item.base,
          error: '完整材料超过重排上下文，未截断；请整理材料后重试',
        });
        continue;
      }
      await this.persist(
        context,
        item,
        this.failed(item.base, kind === 'auth' ? 'auth' : 'retry'),
      );
    }
  }

  private failed(
    base: RecruitingPairResult,
    reason: 'auth' | 'retry' | 'busy',
  ) {
    return {
      ...base,
      status: 'FAILED' as const,
      error:
        reason === 'auth'
          ? '硅基流动授权不可用'
          : reason === 'busy'
            ? '该人岗组合正在评分，请稍后重试以复用结果'
            : '重排请求失败，可重试；未计为零分',
    };
  }

  private async persist(
    context: WorkspaceAuthContext,
    item: PendingPair,
    result: RecruitingPairResult,
  ) {
    item.result = result;
    await this.records.update(
      context,
      'recruitingPairEvaluation',
      item.prepared.cacheId,
      {
        id: item.prepared.cacheId,
        name: `${item.prepared.candidate.id} / ${item.prepared.job.id}`,
        candidateId: item.prepared.candidate.id,
        jobId: item.prepared.job.id,
        status: result.status,
        score: null,
        payload: result,
      },
    );
  }

  private async claim(context: WorkspaceAuthContext, item: PendingPair) {
    let previous;
    try {
      previous = await this.records.one(
        context,
        'recruitingPairEvaluation',
        item.prepared.cacheId,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    const pending = {
      name: `${item.prepared.candidate.id} / ${item.prepared.job.id}`,
      candidateId: item.prepared.candidate.id,
      jobId: item.prepared.job.id,
      status: 'PROCESSING',
      score: null,
      payload: item.base,
    };
    if (previous)
      await this.records.update(
        context,
        'recruitingPairEvaluation',
        item.prepared.cacheId,
        pending,
      );
    else
      await this.records.create(context, 'recruitingPairEvaluation', {
        id: item.prepared.cacheId,
        ...pending,
      });
  }

  private async lockAll(
    context: WorkspaceAuthContext,
    group: PendingPair[],
    fn: () => Promise<void>,
  ) {
    const ordered = [...group].sort((left, right) =>
      left.prepared.cacheId.localeCompare(right.prepared.cacheId, 'en'),
    );
    const step = async (index: number): Promise<{ ok: boolean }> => {
      if (index >= ordered.length) {
        await fn();
        return { ok: true };
      }
      const locked = await this.locks.tryWithLock(
        `recruiting-pair:${context.workspace.id}:${ordered[index].prepared.cacheId}`,
        () => step(index + 1),
      );
      if (!locked.acquired) return { ok: false };
      return locked.value as { ok: boolean };
    };
    return (await step(0)).ok;
  }

  private reusable(payload: RecruitingPairResult | undefined, key: string) {
    return (
      payload?.status === 'SCORED' &&
      payload.scoreKind === RERANK_SCORE_KIND &&
      typeof payload.relevanceScore === 'number' &&
      payload.cacheKey === key &&
      Date.now() - Date.parse(payload.evaluatedAt) < 24 * 60 * 60_000
    );
  }

  private async cached(context: WorkspaceAuthContext, id: string, key: string) {
    try {
      const record = await this.records.one(
        context,
        'recruitingPairEvaluation',
        id,
      );
      const payload = record.payload as RecruitingPairResult | undefined;
      return this.reusable(payload, key) ? payload : undefined;
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }
}
