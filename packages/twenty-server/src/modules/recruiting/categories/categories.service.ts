/** Stores the active category catalog for each recruiting workspace. */
import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';

const CATEGORY_KEY = 'recruiting.categories';
const catalogSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const DEFAULT_CATEGORIES = [
  { id: 'engineering', name: '工程' },
  { id: 'product', name: '产品' },
  { id: 'design', name: '设计' },
  { id: 'operations', name: '运营' },
  { id: 'growth_marketing', name: '增长与市场' },
  { id: 'sales_business', name: '销售与商务' },
  { id: 'data_ai', name: '数据与 AI' },
];

@Injectable()
export class RecruitingCategoriesService {
  constructor(
    @InjectRepository(KeyValuePairEntity)
    private readonly repository: Repository<KeyValuePairEntity>,
  ) {}

  private scope(workspaceId: string) {
    return {
      key: CATEGORY_KEY,
      type: KeyValuePairType.CONFIG_VARIABLE,
      workspaceId,
      userId: IsNull(),
      applicationId: IsNull(),
    };
  }

  private catalog(row: KeyValuePairEntity | null) {
    return row ? catalogSchema.parse(row.value) : DEFAULT_CATEGORIES;
  }

  async list(workspaceId: string) {
    return this.catalog(
      await this.repository.findOneBy(this.scope(workspaceId)),
    );
  }

  async change(workspaceId: string, action: { name: string } | { id: string }) {
    return this.repository.manager.transaction(async (manager) => {
      // Serialize read-modify-write even before the catalog row exists.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [CATEGORY_KEY + ':' + workspaceId],
      );
      const repository = manager.getRepository(KeyValuePairEntity);
      const row = await repository.findOneBy(this.scope(workspaceId));
      const catalog = this.catalog(row);
      if (
        'name' in action &&
        (catalog.length >= 50 ||
          catalog.some(
            ({ name }) =>
              name.normalize('NFKC').toLowerCase() ===
              action.name.normalize('NFKC').toLowerCase(),
          ))
      )
        throw new ConflictException('分类名称已存在，或已达到 50 个分类上限');

      const next =
        'name' in action
          ? [...catalog, { id: randomUUID(), name: action.name }]
          : catalog.filter(({ id }) => id !== action.id);
      await repository.save({
        ...row,
        key: CATEGORY_KEY,
        workspaceId,
        type: KeyValuePairType.CONFIG_VARIABLE,
        value: next as unknown as JSON,
      });
      return next;
    });
  }
}
