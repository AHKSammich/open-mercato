import { reindexEntity } from '../lib/reindexer'
import { upsertIndexBatch, type UpsertIndexBatchResult } from '../lib/batch'
import { prepareJob } from '../lib/jobs'
import { purgeOrphans } from '../lib/stale'

jest.mock('../lib/batch', () => {
  const actual = jest.requireActual('../lib/batch')
  return { ...actual, upsertIndexBatch: jest.fn() }
})

jest.mock('../lib/coverage', () => ({
  applyCoverageAdjustments: jest.fn(async () => undefined),
  refreshCoverageSnapshot: jest.fn(async () => undefined),
  writeCoverageCounts: jest.fn(async () => undefined),
  deleteScopedCoverageForEntity: jest.fn(async () => undefined),
}))

jest.mock('../lib/jobs', () => ({
  prepareJob: jest.fn(async () => undefined),
  updateJobProgress: jest.fn(async () => undefined),
  finalizeJob: jest.fn(async () => undefined),
}))

jest.mock('../lib/stale', () => ({
  purgeOrphans: jest.fn(async () => undefined),
  retireScopedCatalogueRows: jest.fn(async () => undefined),
}))

/**
 * `reindexEntity` reads `entity_index_jobs` twice for its own scope: the active-job guard
 * (is a sweep of this scope already running?) and the started-at lookup that dates the
 * orphan purge. `lib/jobs.ts` files the job row under the caller's organization, so both
 * reads must ask for that organization - not for the null one. Every reindex queued by
 * `/api/query_index/reindex` carries an organization, so a null-only read made the guard a
 * no-op for all of them.
 *
 * The fake database below evaluates the predicates each read actually binds against a
 * seeded job table, so the tests observe what the SQL would select rather than how the
 * query is spelled.
 */

const mockUpsertIndexBatch = upsertIndexBatch as jest.MockedFunction<typeof upsertIndexBatch>
const mockPrepareJob = prepareJob as jest.MockedFunction<typeof prepareJob>
const mockPurgeOrphans = purgeOrphans as jest.MockedFunction<typeof purgeOrphans>

const TENANT = '0e40f2bf-a7ab-465c-8040-20abbd8ad398'
const ORG = 'b7c1c0f0-3d2b-4a91-9a4a-2f3f0a1b2c3d'
const OTHER_ORG = '5d6c7b8a-1e2f-4a3b-9c4d-5e6f7a8b9c0d'
const ENTITY = 'example:todo'
const TABLE = 'todos'
const COLUMNS = ['id', 'tenant_id', 'organization_id', 'deleted_at']

type JobRow = {
  entity_type: string
  organization_id: string | null
  tenant_id: string | null
  partition_index: number | null
  partition_count: number | null
  started_at: Date
  heartbeat_at: Date | null
  finished_at: Date | null
}

type Predicate = (row: JobRow) => boolean

function jobRow(partial: Partial<JobRow>): JobRow {
  return {
    entity_type: ENTITY,
    organization_id: null,
    tenant_id: TENANT,
    partition_index: null,
    partition_count: null,
    started_at: new Date('2026-08-01T00:00:00Z'),
    heartbeat_at: new Date(),
    finished_at: null,
    ...partial,
  }
}

type RawNode = { sqlFragments: readonly string[]; parameters: ReadonlyArray<{ value: unknown }> }

function toPredicate(args: unknown[]): Predicate {
  const [first, operator, value] = args
  const raw = (first as { toOperationNode?: () => RawNode })?.toOperationNode?.()
  if (raw) {
    const heartbeatWindow = /^heartbeat_at > now\(\) - make_interval\(secs => \?\)$/.test(raw.sqlFragments.join('?'))
    if (heartbeatWindow) {
      const seconds = Number(raw.parameters[0]?.value)
      return (row) => row.heartbeat_at !== null && row.heartbeat_at.getTime() > Date.now() - seconds * 1000
    }
    const column = /(\w+) is not distinct from/.exec(raw.sqlFragments.join('?'))?.[1] as keyof JobRow | undefined
    if (!column) throw new Error(`[internal] unsupported raw predicate: ${raw.sqlFragments.join('?')}`)
    const bound = raw.parameters[0]?.value ?? null
    return (row) => (row[column] ?? null) === bound
  }
  const column = String(first) as keyof JobRow
  if (operator === 'is' && value === null) return (row) => row[column] === null
  if (operator === '=') return (row) => row[column] === value
  throw new Error(`[internal] unsupported predicate: ${String(first)} ${String(operator)}`)
}

function createFakeDb(jobs: JobRow[]) {
  const pages = [[{ id: 'todo-1', tenant_id: TENANT, organization_id: ORG }]]
  const chainFor = (target: string): any => {
    const predicates: Predicate[] = []
    let isPageQuery = false
    const chain: any = {
      select: () => chain,
      selectAll: () => { isPageQuery = true; return chain },
      where: (...args: unknown[]) => {
        if (target === 'entity_index_jobs') predicates.push(toPredicate(args))
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      groupBy: () => chain,
      execute: async () => {
        if (target === 'information_schema.columns') return COLUMNS.map((column_name) => ({ column_name }))
        if (target.startsWith(TABLE) && isPageQuery) return pages.shift() ?? []
        return []
      },
      executeTakeFirst: async () => {
        if (target.startsWith(TABLE)) return { count: 1 }
        if (target === 'entity_index_jobs') {
          return jobs
            .filter((row) => predicates.every((predicate) => predicate(row)))
            .sort((left, right) => right.started_at.getTime() - left.started_at.getTime())[0]
        }
        return undefined
      },
    }
    return chain
  }
  const deleteChain: any = { where: () => deleteChain, execute: async () => undefined }
  return {
    selectFrom: (target: unknown) => chainFor(String(target)),
    insertInto: (target: unknown) => chainFor(String(target)),
    updateTable: (target: unknown) => chainFor(String(target)),
    deleteFrom: () => deleteChain,
  }
}

function makeEm(jobs: JobRow[]) {
  const db = createFakeDb(jobs)
  return {
    getKysely: () => db,
    getMetadata: () => ({
      find: () => ({ tableName: TABLE }),
      getAll: () => [{ tableName: TABLE }],
    }),
  } as any
}

const SKIPPED = { processed: 0, total: 0, tenantScopes: [], scopes: [] }

beforeEach(() => {
  jest.clearAllMocks()
  const written: UpsertIndexBatchResult = { attempted: 1, written: 1, failedRecordIds: [], searchTokenFailures: 0 }
  mockUpsertIndexBatch.mockResolvedValue(written)
})

describe('reindexEntity active-job guard for an organization-scoped sweep', () => {
  it('skips the sweep while an unfinished job of the same organization is running', async () => {
    const em = makeEm([jobRow({ organization_id: ORG })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(result).toEqual(SKIPPED)
    expect(mockPrepareJob).not.toHaveBeenCalled()
    expect(mockUpsertIndexBatch).not.toHaveBeenCalled()
  })

  it('skips only the matching partition of the same organization', async () => {
    const em = makeEm([jobRow({ organization_id: ORG, partition_index: 1, partition_count: 3 })])

    const blocked = await reindexEntity(em, {
      entityType: ENTITY, tenantId: TENANT, organizationId: ORG, partitionCount: 3, partitionIndex: 1,
    })
    const sibling = await reindexEntity(em, {
      entityType: ENTITY, tenantId: TENANT, organizationId: ORG, partitionCount: 3, partitionIndex: 2,
    })

    expect(blocked).toEqual(SKIPPED)
    expect(sibling.processed).toBe(1)
    expect(mockPrepareJob).toHaveBeenCalledTimes(1)
  })

  it('does not skip the sweep because of an unfinished job of another organization', async () => {
    const em = makeEm([jobRow({ organization_id: OTHER_ORG })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(result.processed).toBe(1)
    expect(mockPrepareJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, tenantId: TENANT }),
      'reindexing',
      expect.anything(),
    )
  })

  it('does not skip the sweep because of an unfinished organization-less job of the same tenant', async () => {
    const em = makeEm([jobRow({ organization_id: null })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(result.processed).toBe(1)
    expect(mockPrepareJob).toHaveBeenCalledTimes(1)
  })

  it('still skips an organization-less sweep while an organization-less job is running', async () => {
    const em = makeEm([jobRow({ organization_id: null })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: null })

    expect(result).toEqual(SKIPPED)
    expect(mockPrepareJob).not.toHaveBeenCalled()
  })

  it('takes over the scope from a job of the same organization whose heartbeat went silent', async () => {
    const em = makeEm([jobRow({ organization_id: ORG, heartbeat_at: new Date(Date.now() - 60 * 60 * 1000) })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(result.processed).toBe(1)
    expect(mockPrepareJob).toHaveBeenCalledTimes(1)
  })

  it('runs a forced sweep regardless of a running job of the same organization', async () => {
    const em = makeEm([jobRow({ organization_id: ORG })])

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG, force: true })

    expect(result.processed).toBe(1)
    expect(mockPrepareJob).toHaveBeenCalledTimes(1)
  })
})

describe('reindexEntity orphan-purge start time for an organization-scoped sweep', () => {
  it('dates the purge from the job row of its own organization', async () => {
    const ownStart = new Date('2026-09-02T10:00:00Z')
    const em = makeEm([
      jobRow({ organization_id: ORG, started_at: ownStart, finished_at: new Date('2026-09-02T10:05:00Z') }),
      jobRow({
        organization_id: null,
        started_at: new Date('2026-09-01T10:00:00Z'),
        finished_at: new Date('2026-09-01T10:05:00Z'),
      }),
    ])

    await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(mockPurgeOrphans).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, startedAt: ownStart }),
    )
  })
})
