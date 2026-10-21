jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@open-mercato/shared/lib/commands/helpers', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/commands/helpers')
  return {
    ...actual,
    emitCrudSideEffects: jest.fn(async () => undefined),
    emitCrudUndoSideEffects: jest.fn(async () => undefined),
  }
})

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (
    em: { find: (entityName: unknown, where: unknown, options?: unknown) => Promise<unknown[]> },
    entityName: unknown,
    where: unknown,
    options?: unknown,
  ) => em.find(entityName, where, options),
  findOneWithDecryption: async () => null,
}))

import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { CustomerEntity, CustomerTag, CustomerTagAssignment } from '../../data/entities'
import '../tags'

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999'
const TAG_ID = '33333333-3333-4333-8333-333333333333'
const PERSON_ID = '44444444-4444-4444-8444-444444444444'
const COMPANY_ID = '55555555-5555-4555-8555-555555555555'
const DELETED_ID = '66666666-6666-4666-8666-666666666666'
const FOREIGN_ID = '77777777-7777-4777-8777-777777777777'
const OTHER_TENANT_ID = '88888888-8888-4888-8888-888888888888'
const FOREIGN_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type Row = Record<string, unknown>

function idOf(value: unknown): unknown {
  if (value && typeof value === 'object' && 'id' in value) return (value as { id: unknown }).id
  return value
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = idOf(row[key])
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return ((expected as { $in: unknown[] }).$in).map(idOf).includes(actual)
    }
    if (expected === null) return actual === null || actual === undefined
    return actual === idOf(expected)
  })
}

function makeStore(assignedEntityIds: string[]) {
  const entities: Row[] = [
    { id: PERSON_ID, organizationId: ORG_ID, tenantId: TENANT_ID, deletedAt: null },
    { id: COMPANY_ID, organizationId: ORG_ID, tenantId: TENANT_ID, deletedAt: null },
    { id: DELETED_ID, organizationId: ORG_ID, tenantId: TENANT_ID, deletedAt: null },
    { id: FOREIGN_ID, organizationId: OTHER_ORG_ID, tenantId: TENANT_ID, deletedAt: null },
    { id: FOREIGN_TENANT_ID, organizationId: ORG_ID, tenantId: OTHER_TENANT_ID, deletedAt: null },
  ]
  const tags: Row[] = [
    { id: TAG_ID, organizationId: ORG_ID, tenantId: TENANT_ID, slug: 'vip', label: 'VIP', color: null, description: null },
  ]
  const assignments: Row[] = assignedEntityIds.map((entityId, index) => ({
    id: `assignment-${index + 1}`,
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
    tag: tags[0],
    entity: entities.find((entity) => entity.id === entityId),
  }))
  const tables = new Map<unknown, Row[]>([
    [CustomerEntity, entities],
    [CustomerTag, tags],
    [CustomerTagAssignment, assignments],
  ])
  const pending: Array<{ entityName: unknown; row: Row }> = []
  const removed = new Set<Row>()

  const em = {
    fork: () => em,
    findOne: jest.fn(async (entityName: unknown, where: Row) => (tables.get(entityName) ?? []).find((row) => matches(row, where)) ?? null),
    find: jest.fn(async (entityName: unknown, where: Row) => (tables.get(entityName) ?? []).filter((row) => matches(row, where))),
    nativeDelete: jest.fn(async (entityName: unknown, where: Row) => {
      const table = tables.get(entityName) ?? []
      const kept = table.filter((row) => !matches(row, where))
      const deleted = table.length - kept.length
      table.splice(0, table.length, ...kept)
      return deleted
    }),
    create: jest.fn((_entityName: unknown, data: Row) => ({ ...data })),
    persist: jest.fn((row: Row) => {
      const entityName = 'slug' in row ? CustomerTag : CustomerTagAssignment
      const known = (tables.get(entityName) ?? []).includes(row) || pending.some((entry) => entry.row === row)
      if (!known) pending.push({ entityName, row })
      return em
    }),
    remove: jest.fn((row: Row) => {
      removed.add(row)
      return em
    }),
    getReference: jest.fn((_entityName: unknown, id: string) => ({ id })),
    flush: jest.fn(async () => {
      for (const { entityName, row } of pending.splice(0)) {
        const table = tables.get(entityName) ?? []
        if (entityName === CustomerTagAssignment && table.some((existing) => idOf(existing.tag) === idOf(row.tag) && idOf(existing.entity) === idOf(row.entity))) {
          throw new Error('duplicate key value violates unique constraint "customer_tag_assignments_unique"')
        }
        table.push(row)
      }
      for (const row of removed) {
        for (const table of tables.values()) {
          const index = table.indexOf(row)
          if (index >= 0) table.splice(index, 1)
        }
      }
      removed.clear()
    }),
    isInTransaction: () => false,
    begin: jest.fn(async () => undefined),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
    getUnitOfWork: () => ({ getChangeSets: () => [] }),
  }

  return { em, entities, tags, assignments }
}

function makeCtx(em: unknown): CommandRuntimeContext {
  return {
    container: {
      resolve: (token: string) => {
        if (token === 'em') return em
        if (token === 'dataEngine') return {}
        throw new Error(`[internal] unexpected DI token: ${token}`)
      },
    },
    auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID },
    selectedOrganizationId: ORG_ID,
    organizationScope: null,
    organizationIds: [ORG_ID],
  } as unknown as CommandRuntimeContext
}

type DeleteHandler = CommandHandler<{ body?: Record<string, unknown> }, { tagId: string }>

function deleteHandler(): DeleteHandler {
  const handler = commandRegistry.get('customers.tags.delete') as DeleteHandler | null
  if (!handler?.prepare || !handler.buildLog || !handler.undo) throw new Error('[internal] customers.tags.delete is incomplete')
  return handler
}

async function deleteTag(em: unknown) {
  const handler = deleteHandler()
  const ctx = makeCtx(em)
  const input = { body: { id: TAG_ID } }
  const snapshots = (await handler.prepare!(input, ctx)) ?? {}
  const result = await handler.execute(input, ctx)
  const log = await handler.buildLog!({ input, result, ctx, snapshots })
  const storedPayload = JSON.parse(JSON.stringify(log?.payload ?? null))
  return { handler, ctx, log, logEntry: { id: 'log-1', commandPayload: storedPayload } }
}

function assignmentState(assignments: Row[]) {
  return assignments
    .map((row) => ({ id: row.id, tagId: idOf(row.tag), entityId: idOf(row.entity), createdAt: row.createdAt }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

describe('customers.tags.delete undo restores tag assignments', () => {
  it('restores every assignment the delete removed, keeping ids and timestamps', async () => {
    const { em, tags, assignments } = makeStore([PERSON_ID, COMPANY_ID])
    const before = assignmentState(assignments)
    expect(before).toHaveLength(2)

    const { handler, ctx, logEntry } = await deleteTag(em)
    expect(tags).toHaveLength(0)
    expect(assignments).toHaveLength(0)

    await handler.undo!({ input: { body: { id: TAG_ID } }, ctx, logEntry } as never)

    expect(tags.map((tag) => tag.id)).toEqual([TAG_ID])
    expect(assignmentState(assignments)).toEqual(before)
  })

  it('flushes the cached customer details that list tag assignments on delete and undo', async () => {
    const { em } = makeStore([PERSON_ID])
    const { log } = await deleteTag(em)

    expect(log?.context).toEqual({ cacheAliases: ['customers.tagAssignment'] })
  })

  it('skips customers that were deleted or are outside the tag scope', async () => {
    const { em, entities, assignments } = makeStore([PERSON_ID, DELETED_ID, FOREIGN_ID, FOREIGN_TENANT_ID])
    const { handler, ctx, logEntry } = await deleteTag(em)
    const deletedEntity = entities.find((entity) => entity.id === DELETED_ID)
    if (deletedEntity) deletedEntity.deletedAt = new Date()

    await handler.undo!({ input: { body: { id: TAG_ID } }, ctx, logEntry } as never)

    expect(assignmentState(assignments).map((row) => row.entityId)).toEqual([PERSON_ID])
  })

  it('does not duplicate an assignment that already exists when the undo runs', async () => {
    const { em, entities, tags, assignments } = makeStore([PERSON_ID])
    const { handler, ctx, logEntry } = await deleteTag(em)
    tags.push({ id: TAG_ID, organizationId: ORG_ID, tenantId: TENANT_ID, slug: 'vip', label: 'VIP', color: null, description: null })
    assignments.push({
      id: 'assignment-new',
      organizationId: ORG_ID,
      tenantId: TENANT_ID,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      tag: tags[0],
      entity: entities.find((entity) => entity.id === PERSON_ID),
    })

    await handler.undo!({ input: { body: { id: TAG_ID } }, ctx, logEntry } as never)

    expect(assignmentState(assignments).map((row) => row.id)).toEqual(['assignment-new'])
  })

  it('restores only the tag for undo payloads written before assignments were captured', async () => {
    const { em, tags, assignments } = makeStore([PERSON_ID])
    const { handler, ctx, logEntry } = await deleteTag(em)
    const legacyUndo = { ...(logEntry.commandPayload as { undo: Record<string, unknown> }).undo }
    delete legacyUndo.assignments

    await handler.undo!({ input: { body: { id: TAG_ID } }, ctx, logEntry: { id: 'log-1', commandPayload: { undo: legacyUndo } } } as never)

    expect(tags.map((tag) => tag.id)).toEqual([TAG_ID])
    expect(assignments).toHaveLength(0)
  })
})
