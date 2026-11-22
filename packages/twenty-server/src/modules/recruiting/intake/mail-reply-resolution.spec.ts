/** Proves a reply attaches to one live candidate and refuses a mixed identity. */
import { ConflictException } from '@nestjs/common';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { RecruitingCandidateRecordsService } from './candidate-records.service';
import { RecruitingIntakeService } from './intake.service';

const context = { workspace: { id: 'workspace' } } as WorkspaceAuthContext;

const repository = (
  rowsFor: (alias: string, sql: string) => Record<string, unknown>[],
) => ({
  createQueryBuilder: (alias: string) => {
    const sql: string[] = [];
    const query = {
      select: () => query,
      where: (fragment?: unknown) => {
        sql.push(
          typeof fragment === 'string' ? fragment : JSON.stringify(fragment),
        );
        return query;
      },
      andWhere: (fragment?: unknown) => {
        sql.push(
          typeof fragment === 'string' ? fragment : JSON.stringify(fragment),
        );
        return query;
      },
      getRawMany: async () => rowsFor(alias, sql.join('\n')),
    };
    return query;
  },
});

it('resolves one sender address before treating the message as a new person', async () => {
  const orm = {
    executeInWorkspaceContext: async (callback: () => Promise<unknown>) =>
      callback(),
    getRepositoryWithContextPermissions: () =>
      repository((_alias, sql) =>
        sql.includes('emailsPrimaryEmail') ? [{ person_id: 'candidate' }] : [],
      ),
  };
  const service = new RecruitingCandidateRecordsService(
    orm as unknown as WorkspaceOrmManager,
  );
  await expect(
    service.resolveMailCandidate(context, {
      from: '候选人 <person@example.test>',
      subject: '回复：岗位',
    }),
  ).resolves.toEqual({ id: 'candidate', reason: 'email' });
});

it('uses the earlier message thread when the reply address is new', async () => {
  const orm = {
    executeInWorkspaceContext: async (callback: () => Promise<unknown>) =>
      callback(),
    getRepositoryWithContextPermissions: () =>
      repository((alias, sql) => {
        if (sql.includes('emailsPrimaryEmail')) return [];
        if (alias === 'archive')
          return [{ archive_payload: { intakeIds: ['intake'] } }];
        if (alias === 'intake') return [{ intake_targetId: 'candidate' }];
        if (sql.includes('targetIds')) return [{ person_id: 'candidate' }];
        return [];
      }),
  };
  const service = new RecruitingCandidateRecordsService(
    orm as unknown as WorkspaceOrmManager,
  );
  await expect(
    service.resolveMailCandidate(context, {
      from: 'new@example.test',
      subject: '补充材料',
      inReplyTo: '<old@mail>',
    }),
  ).resolves.toEqual({ id: 'candidate', reason: 'thread' });
});

it('does not attach a reply when the same name matches two candidates', async () => {
  const orm = {
    executeInWorkspaceContext: async (callback: () => Promise<unknown>) =>
      callback(),
    getRepositoryWithContextPermissions: () =>
      repository((_alias, sql) =>
        sql.includes('nameFirstName')
          ? [{ person_id: 'one' }, { person_id: 'two' }]
          : [],
      ),
  };
  const service = new RecruitingCandidateRecordsService(
    orm as unknown as WorkspaceOrmManager,
  );
  await expect(
    service.resolveMailCandidate(context, {
      subject: '回复：李雷',
      inReplyTo: '<old@mail>',
    }),
  ).resolves.toEqual({
    ambiguous: true,
    reason: 'name+thread',
    ids: ['one', 'two'],
  });
});

it('stores a resolved reply on the existing candidate and skips matching', async () => {
  const actor = { workspaceId: 'workspace' };
  let intake: Record<string, unknown> = {
    id: 'intake',
    state: 'READY',
    result: {
      schemaVersion: 2,
      actor,
      inputHash: 'hash',
      stage: 'QUEUED',
      input: {
        kind: 'CANDIDATE',
        source: 'email',
        files: [{ fileId: 'file', label: '补充.pdf', role: 'primary' }],
        mail: {
          metadata: {
            subject: 'Re: 后端',
            from: 'person@example.test',
            inReplyTo: '<old@mail>',
          },
        },
      },
    },
  };
  const records = {
    one: jest.fn(async () => structuredClone(intake)),
    update: jest.fn(async (_context, _object, _id, patch) => {
      intake = { ...intake, ...structuredClone(patch) };
      return structuredClone(intake);
    }),
  };
  const candidates = {
    resolveMailCandidate: jest.fn(async () => ({
      id: 'candidate',
      reason: 'thread',
    })),
    attachMailMaterials: jest.fn(async () => undefined),
    replaceProfile: jest.fn(),
  };
  const parser = {
    copyResumeAttachment: jest.fn(async () => ({ id: 'copy' })),
  };
  const extractor = { candidate: jest.fn() };
  const matching = { submitForRecord: jest.fn() };
  const service = new RecruitingIntakeService(
    records as never,
    { resolve: async () => context } as never,
    parser as never,
    extractor as never,
    matching as never,
    {} as never,
    {} as never,
    candidates as never,
    {} as never,
  );
  await service.process({ intakeId: 'intake', actor });
  expect(parser.copyResumeAttachment).toHaveBeenCalledWith(actor, 'file');
  expect(candidates.attachMailMaterials).toHaveBeenCalledWith(
    context,
    'candidate',
    [{ fileId: 'copy', label: '补充.pdf' }],
    ['person@example.test'],
  );
  expect(candidates.replaceProfile).not.toHaveBeenCalled();
  expect(extractor.candidate).not.toHaveBeenCalled();
  expect(matching.submitForRecord).not.toHaveBeenCalled();
  expect(intake).toMatchObject({
    state: 'COMPLETED',
    targetId: 'candidate',
    result: {
      matchingStatus: 'SKIPPED',
      mailAttachOnly: true,
      mailResolveReason: 'thread',
    },
  });
});

it('stops an ambiguous reply before parsing or scoring', async () => {
  const intake = {
    id: 'intake',
    state: 'READY',
    result: {
      schemaVersion: 2,
      actor: { workspaceId: 'workspace' },
      inputHash: 'hash',
      stage: 'QUEUED',
      input: {
        kind: 'CANDIDATE',
        source: 'email',
        files: [],
        mail: { subject: '回复：李雷' },
      },
    },
  };
  const records = {
    one: jest.fn(async () => structuredClone(intake)),
    update: jest.fn(async (_context, _object, _id, patch) => ({
      ...intake,
      ...patch,
    })),
  };
  const candidates = {
    resolveMailCandidate: jest.fn(async () => ({
      ambiguous: true,
      reason: 'name+thread',
      ids: ['one', 'two'],
    })),
  };
  const parser = { parse: jest.fn(), copyResumeAttachment: jest.fn() };
  const service = new RecruitingIntakeService(
    records as never,
    { resolve: async () => context } as never,
    parser as never,
    { candidate: jest.fn() } as never,
    { submitForRecord: jest.fn() } as never,
    {} as never,
    {} as never,
    candidates as never,
    {} as never,
  );
  await service.process({
    intakeId: 'intake',
    actor: { workspaceId: 'workspace' },
  });
  expect(parser.parse).not.toHaveBeenCalled();
  expect(records.update).toHaveBeenCalledWith(
    context,
    'recruitingIntake',
    'intake',
    expect.objectContaining({
      state: 'NEEDS_REVIEW',
      error: '这封回信对应多位同名或同邮箱候选人，请指定要归入的档案',
    }),
  );
  expect(records.update.mock.calls[0][3].error).not.toBeInstanceOf(
    ConflictException,
  );
});
