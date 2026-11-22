import { candidateFields } from './candidate-fields';
import {
  collectMessageIds,
  extractNamesFromMail,
  isReplyMail,
  normalizeEmail,
  normalizeMessageId,
  senderEmailsFromMetadata,
} from '../mail/domain/mail-reply';
/** Appends material references with native optimistic concurrency while replacing only generated career facts. */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isPlainObject } from 'twenty-shared/utils';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type RecruitingRecord } from '../records/records.service';

@Injectable()
/** Retains original attachment references even when another intake, portal or native editor updates the same person. */
export class RecruitingCandidateRecordsService {
  constructor(private readonly orm: WorkspaceOrmManager) {}

  /** Re-reads and merges after each native version conflict, never holding a database lock during parsing or inference. */
  async replaceProfile(
    context: WorkspaceAuthContext,
    id: string,
    recruitingProfile: Record<string, unknown>,
    files: { fileId: string; label: string }[],
  ) {
    return this.orm.executeInWorkspaceContext(async () => {
      const repository = this.orm.getRepositoryWithContextPermissions('person');
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await repository
          .createQueryBuilder('person')
          .select([
            'id',
            'updatedAt',
            'contactRoles',
            'candidateResumes',
            'jobTitle',
            'phonesPrimaryPhoneNumber',
            'phonesPrimaryPhoneCallingCode',
            'phonesPrimaryPhoneCountryCode',
            'phonesAdditionalPhones',
            'candidateEmploymentType',
          ])
          .where({ id })
          .getRawAndEntities<RecruitingRecord>();
        const candidate = result.entities[0];
        const version = result.raw[0]?.person_updatedAt;
        if (!candidate || typeof version !== 'string')
          throw new NotFoundException('候选人不存在或当前无权访问');
        if (
          !Array.isArray(candidate.contactRoles) ||
          !candidate.contactRoles.includes('CANDIDATE')
        )
          throw new BadRequestException(
            '目标联系人已不属于候选人，请核对后重新提交',
          );
        const previous = Array.isArray(candidate.candidateResumes)
          ? candidate.candidateResumes
          : [];
        const resumes = previous
          .filter(
            (old) =>
              !files.some(
                (file) => isPlainObject(old) && old.fileId === file.fileId,
              ),
          )
          .map((old) => {
            if (
              !isPlainObject(old) ||
              typeof old.fileId !== 'string' ||
              typeof old.label !== 'string'
            )
              throw new BadRequestException(
                '既有简历附件引用需要核对，系统未覆盖原有附件',
              );
            return { fileId: old.fileId, label: old.label };
          });
        const query = repository
          .createQueryBuilder('person')
          .where({ id })
          .andWhere(
            '"person"."updatedAt" = CAST(:expectedVersion AS timestamptz)',
            { expectedVersion: version },
          );
        const updated = await repository.runMutation({
          selectQueryBuilder: query,
          rowLevelPermissionsApplied: false,
          kind: 'update',
          columnsToReturn: ['id'],
          data: {
            ...candidateFields(recruitingProfile, candidate),
            recruitingProfile,
            candidateResumes: [...resumes, ...files],
          },
        });
        if (updated.length === 1) return;
      }
      throw new ConflictException(
        '候选人资料正在被修改，原件已保留，请稍后重试',
      );
    }, context);
  }

  private rowId(row: Record<string, unknown> | undefined) {
    return typeof row?.person_id === 'string'
      ? row.person_id
      : typeof row?.id === 'string'
        ? row.id
        : undefined;
  }

  async findCandidateIdsByEmailsForContext(
    context: WorkspaceAuthContext,
    emails: string[],
  ) {
    return this.orm.executeInWorkspaceContext(
      async () => this.findCandidateIdsByEmails(emails),
      context,
    );
  }

  /** Matches live candidates by primaryEmail or additionalEmails. */
  async findCandidateIdsByEmails(emails: string[]) {
    const normalized = [
      ...new Set(emails.map((value) => normalizeEmail(value)).filter(Boolean)),
    ];
    if (!normalized.length) return [];
    const repository = this.orm.getRepositoryWithContextPermissions('person');
    const rows = await repository
      .createQueryBuilder('person')
      .select(['id'])
      .where('"person"."deletedAt" IS NULL')
      .andWhere(`'CANDIDATE' = ANY("person"."contactRoles")`)
      .andWhere(
        `(
            lower(trim("person"."emailsPrimaryEmail")) IN (:...emails)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(COALESCE("person"."emailsAdditionalEmails", '[]'::jsonb)) AS addr
              WHERE lower(trim(addr)) IN (:...emails)
            )
          )`,
        { emails: normalized },
      )
      .getRawMany<Record<string, unknown>>();
    return [
      ...new Set(rows.map((row) => this.rowId(row)).filter(Boolean)),
    ] as string[];
  }

  async findCandidateIdsByExactName(name: string) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value) return [];
    const repository = this.orm.getRepositoryWithContextPermissions('person');
    const rows = await repository
      .createQueryBuilder('person')
      .select(['id'])
      .where('"person"."deletedAt" IS NULL')
      .andWhere(`'CANDIDATE' = ANY("person"."contactRoles")`)
      .andWhere(
        `(
            lower(trim(both from concat_ws('', "person"."nameLastName", "person"."nameFirstName"))) = lower(:name)
            OR lower(trim(both from "person"."nameFirstName")) = lower(:name)
            OR lower(trim(both from "person"."nameLastName")) = lower(:name)
            OR lower(trim(both from concat_ws('', "person"."nameLastName", "person"."nameFirstName"))) LIKE lower(:name) || '（%'
            OR lower(trim(both from concat_ws('', "person"."nameLastName", "person"."nameFirstName"))) LIKE lower(:name) || '(%'
            OR lower(trim(both from "person"."nameFirstName")) LIKE lower(:name) || '（%'
            OR lower(trim(both from "person"."nameFirstName")) LIKE lower(:name) || '(%'
          )`,
        { name: value },
      )
      .getRawMany<Record<string, unknown>>();
    return [
      ...new Set(rows.map((row) => this.rowId(row)).filter(Boolean)),
    ] as string[];
  }

  async findCandidateIdsByMailThread(messageIds: string[]) {
    const ids = [
      ...new Set(
        messageIds.map((value) => normalizeMessageId(value)).filter(Boolean),
      ),
    ];
    if (!ids.length) return [];
    const archives = this.orm.getRepositoryWithContextPermissions(
      'recruitingMailArchive',
    );
    const rows = await archives
      .createQueryBuilder('archive')
      .select(['id', 'payload'])
      .where('"archive"."deletedAt" IS NULL')
      .andWhere(
        `(
            lower(regexp_replace(COALESCE("archive"."payload"->'metadata'->>'messageId', ''), '[<>\\s]', '', 'g')) IN (:...ids)
            OR lower(regexp_replace(COALESCE("archive"."payload"->'metadata'->>'inReplyTo', ''), '[<>\\s]', '', 'g')) IN (:...ids)
            OR EXISTS (
              SELECT 1
              FROM unnest(string_to_array(
                regexp_replace(
                  CASE
                    WHEN jsonb_typeof("archive"."payload"->'metadata'->'references') = 'array'
                      THEN COALESCE((
                        SELECT string_agg(ref, ' ')
                        FROM jsonb_array_elements_text("archive"."payload"->'metadata'->'references') AS ref
                      ), '')
                    ELSE COALESCE("archive"."payload"->'metadata'->>'references', '')
                  END,
                  '[<>]',
                  '',
                  'g'
                ),
                E'[\\s,]+'
              )) AS ref
              WHERE lower(trim(ref)) IN (:...ids)
            )
          )`,
        { ids },
      )
      .getRawMany<Record<string, unknown>>();
    const intakeIds = new Set<string>();
    for (const row of rows) {
      const payload = (row.archive_payload ?? row.payload) as
        | { intakeIds?: unknown }
        | undefined;
      const list =
        payload && typeof payload === 'object' ? payload.intakeIds : undefined;
      if (!Array.isArray(list)) continue;
      for (const intakeId of list) {
        if (typeof intakeId === 'string' && intakeId) intakeIds.add(intakeId);
      }
    }
    if (!intakeIds.size) return [];
    const intakes =
      this.orm.getRepositoryWithContextPermissions('recruitingIntake');
    const intakeRows = await intakes
      .createQueryBuilder('intake')
      .select(['id', 'targetId'])
      .where('"intake"."deletedAt" IS NULL')
      .andWhere('"intake"."state" = :state', { state: 'COMPLETED' })
      .andWhere('"intake"."id" IN (:...intakeIds)', {
        intakeIds: [...intakeIds],
      })
      .andWhere('"intake"."targetId" IS NOT NULL')
      .getRawMany<Record<string, unknown>>();
    const targetIds = [
      ...new Set(
        intakeRows
          .map((row) =>
            typeof row.intake_targetId === 'string'
              ? row.intake_targetId
              : typeof row.targetId === 'string'
                ? row.targetId
                : undefined,
          )
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!targetIds.length) return [];
    const people = this.orm.getRepositoryWithContextPermissions('person');
    const live = await people
      .createQueryBuilder('person')
      .select(['id'])
      .where('"person"."deletedAt" IS NULL')
      .andWhere(`'CANDIDATE' = ANY("person"."contactRoles")`)
      .andWhere('"person"."id" IN (:...targetIds)', { targetIds })
      .getRawMany<Record<string, unknown>>();
    return [
      ...new Set(live.map((row) => this.rowId(row)).filter(Boolean)),
    ] as string[];
  }

  /** Resolves an existing live candidate for a hiring mailbox message by email, thread, then name. */
  async resolveMailCandidate(
    context: WorkspaceAuthContext,
    meta: unknown,
    explicitId?: string,
  ) {
    return this.orm.executeInWorkspaceContext(async () => {
      if (typeof explicitId === 'string' && explicitId) {
        const people = this.orm.getRepositoryWithContextPermissions('person');
        const rows = await people
          .createQueryBuilder('person')
          .select(['id'])
          .where({ id: explicitId })
          .andWhere('"person"."deletedAt" IS NULL')
          .andWhere(`'CANDIDATE' = ANY("person"."contactRoles")`)
          .getRawMany<Record<string, unknown>>();
        const id = rows.length === 1 ? this.rowId(rows[0]) : undefined;
        if (id) return { id, reason: 'explicit' as const };
      }
      const emailIds = await this.findCandidateIdsByEmails(
        senderEmailsFromMetadata(meta),
      );
      if (emailIds.length === 1)
        return { id: emailIds[0], reason: 'email' as const };
      if (emailIds.length > 1)
        return { ambiguous: true, reason: 'email' as const, ids: emailIds };
      if (!isReplyMail(meta)) return {};
      const threadIds = await this.findCandidateIdsByMailThread(
        collectMessageIds(meta),
      );
      if (threadIds.length === 1)
        return { id: threadIds[0], reason: 'thread' as const };
      if (threadIds.length > 1)
        return { ambiguous: true, reason: 'thread' as const, ids: threadIds };
      const nameIds: string[] = [];
      const seen = new Set<string>();
      for (const name of extractNamesFromMail(meta)) {
        for (const id of await this.findCandidateIdsByExactName(name)) {
          if (!seen.has(id)) {
            seen.add(id);
            nameIds.push(id);
          }
        }
      }
      if (nameIds.length === 1)
        return { id: nameIds[0], reason: 'name+thread' as const };
      if (nameIds.length > 1)
        return {
          ambiguous: true,
          reason: 'name+thread' as const,
          ids: nameIds,
        };
      return {};
    }, context);
  }

  private listEmails(record: Record<string, unknown>) {
    const emails = isPlainObject(record.emails) ? record.emails : {};
    const primary = normalizeEmail(
      typeof record.emailsPrimaryEmail === 'string'
        ? record.emailsPrimaryEmail
        : emails.primaryEmail,
    );
    const additionalSource = Array.isArray(record.emailsAdditionalEmails)
      ? record.emailsAdditionalEmails
      : Array.isArray(emails.additionalEmails)
        ? emails.additionalEmails
        : [];
    const additional = additionalSource
      .map((value) => normalizeEmail(value))
      .filter((email): email is string => Boolean(email));
    return {
      primaryEmail: primary,
      additionalEmails: [...new Set(additional)],
    };
  }

  /** Appends mail files and merges sender addresses without replacing recruitingProfile. */
  async attachMailMaterials(
    context: WorkspaceAuthContext,
    id: string,
    files: { fileId: string; label: string }[],
    senderEmails: string[],
  ) {
    return this.orm.executeInWorkspaceContext(async () => {
      const repository = this.orm.getRepositoryWithContextPermissions('person');
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await repository
          .createQueryBuilder('person')
          .select([
            'id',
            'updatedAt',
            'contactRoles',
            'candidateResumes',
            'emailsPrimaryEmail',
            'emailsAdditionalEmails',
          ])
          .where({ id })
          .getRawAndEntities<RecruitingRecord>();
        const candidate = result.entities[0];
        const version = result.raw[0]?.person_updatedAt;
        if (!candidate || typeof version !== 'string')
          throw new NotFoundException('候选人不存在或当前无权访问');
        if (
          !Array.isArray(candidate.contactRoles) ||
          !candidate.contactRoles.includes('CANDIDATE')
        )
          throw new BadRequestException(
            '目标联系人已不属于候选人，请核对后重新提交',
          );
        const previous = Array.isArray(candidate.candidateResumes)
          ? candidate.candidateResumes
          : [];
        const resumes = previous
          .filter(
            (old) =>
              !files.some(
                (file) => isPlainObject(old) && old.fileId === file.fileId,
              ),
          )
          .map((old) => {
            if (
              !isPlainObject(old) ||
              typeof old.fileId !== 'string' ||
              typeof old.label !== 'string'
            )
              throw new BadRequestException(
                '既有简历附件引用需要核对，系统未覆盖原有附件',
              );
            return { fileId: old.fileId, label: old.label };
          });
        const current = this.listEmails({
          ...candidate,
          emailsPrimaryEmail:
            candidate.emailsPrimaryEmail ??
            result.raw[0]?.person_emailsPrimaryEmail,
          emailsAdditionalEmails:
            candidate.emailsAdditionalEmails ??
            result.raw[0]?.person_emailsAdditionalEmails,
        });
        const extras = [
          ...new Set([
            ...current.additionalEmails,
            ...senderEmails
              .map((value) => normalizeEmail(value))
              .filter(
                (email): email is string =>
                  Boolean(email) && email !== current.primaryEmail,
              ),
          ]),
        ];
        const query = repository
          .createQueryBuilder('person')
          .where({ id })
          .andWhere(
            '"person"."updatedAt" = CAST(:expectedVersion AS timestamptz)',
            { expectedVersion: version },
          );
        const data: Record<string, unknown> = {
          candidateResumes: [...resumes, ...files],
        };
        if (current.primaryEmail || extras.length) {
          data.emails = {
            primaryEmail: current.primaryEmail ?? '',
            additionalEmails: extras,
          };
        }
        const updated = await repository.runMutation({
          selectQueryBuilder: query,
          rowLevelPermissionsApplied: false,
          kind: 'update',
          columnsToReturn: ['id'],
          data,
        });
        if (updated.length === 1) return;
      }
      throw new ConflictException(
        '候选人资料正在被修改，原件已保留，请稍后重试',
      );
    }, context);
  }

  async mergeAdditionalEmails(
    context: WorkspaceAuthContext,
    id: string,
    senderEmails: string[],
  ) {
    return this.attachMailMaterials(context, id, [], senderEmails);
  }
}
