/**
 * Pins the active-job guard of `reindexEntity` against a real PostgreSQL: two non-forced
 * sweeps of the same organization-scoped job scope must not run at once. The second one has
 * to see the first one's unfinished `entity_index_jobs` row - filed by the real
 * `prepareJob` under the caller's organization - and step aside instead of resetting its
 * progress through the upsert and finalizing it underneath the running sweep.
 *
 * Gated on OM_COUNT_CAP_PG_URL (a throwaway database - the suite creates and drops its own
 * tables). See count-cap-plan.test.ts in @open-mercato/shared for the invocation recipe.
 */
import { Kysely, PostgresDialect, sql } from 'kysely'
import { reindexEntity } from '../lib/reindexer'
import { upsertIndexBatch, type UpsertIndexBatchResult } from '../lib/batch'
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

jest.mock('../lib/stale', () => ({
  purgeOrphans: jest.fn(async () => undefined),
  retireScopedCatalogueRows: jest.fn(async () => undefined),
}))

const PG_URL = process.env.OM_COUNT_CAP_PG_URL
const maybe = PG_URL ? describe : describe.skip

const mockUpsertIndexBatch = upsertIndexBatch as jest.MockedFunction<typeof upsertIndexBatch>
const mockPurgeOrphans = purgeOrphans as jest.MockedFunction<typeof purgeOrphans>

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const ENTITY = 'example:todo'
const TABLE = 'qidx_active_job_todos'
const RECORDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']

type JobState = { processed_count: number | null; started_at: Date; finished_at: Date | null }

function written(count: number): UpsertIndexBatchResult {
  return { attempted: count, written: count, failedRecordIds: [], searchTokenFailures: 0 }
}

maybe('reindexEntity active-job guard against a real job table', () => {
  jest.setTimeout(60_000)
  let db: Kysely<any>
  let em: any

  const readJob = async (organizationId: string | null): Promise<JobState | undefined> => {
    const result = await sql<JobState>`select processed_count, started_at, finished_at
      from entity_index_jobs
      where entity_type = ${ENTITY}
        and organization_id is not distinct from ${organizationId}::uuid
        and tenant_id = ${TENANT}::uuid`.execute(db)
    return result.rows[0]
  }

  beforeAll(async () => {
    const { Pool } = require('pg')
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL, max: 4 }) }) })
    await sql`create table if not exists entity_index_jobs (
      id uuid primary key default gen_random_uuid(),
      entity_type text not null,
      organization_id uuid,
      tenant_id uuid,
      partition_index integer,
      partition_count integer,
      processed_count integer,
      total_count integer,
      heartbeat_at timestamptz,
      status text not null,
      started_at timestamptz not null,
      finished_at timestamptz
    )`.execute(db)
    await sql`create unique index if not exists entity_index_jobs_scope_unique on entity_index_jobs (
      entity_type,
      coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
      coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
      coalesce(partition_index, -1),
      coalesce(partition_count, -1)
    )`.execute(db)
    await sql`create table if not exists ${sql.table(TABLE)} (
      id uuid primary key,
      tenant_id uuid not null,
      organization_id uuid not null,
      deleted_at timestamptz
    )`.execute(db)
    await sql`delete from ${sql.table(TABLE)}`.execute(db)
    for (const id of RECORDS) {
      await sql`insert into ${sql.table(TABLE)} (id, tenant_id, organization_id)
        values (${id}::uuid, ${TENANT}::uuid, ${ORG}::uuid)`.execute(db)
    }
    em = {
      getKysely: () => db,
      getMetadata: () => ({
        find: () => ({ tableName: TABLE }),
        getAll: () => [{ tableName: TABLE }],
      }),
    }
  })

  beforeEach(async () => {
    jest.clearAllMocks()
    mockUpsertIndexBatch.mockImplementation(async (_db, _entityType, rows) => written(rows.length))
    await sql`delete from entity_index_jobs where entity_type = ${ENTITY}`.execute(db)
  })

  afterAll(async () => {
    await sql`drop table if exists ${sql.table(TABLE)}`.execute(db)
    await sql`delete from entity_index_jobs where entity_type = ${ENTITY}`.execute(db)
    await db.destroy()
  })

  it('a second sweep of the same organization leaves the running sweep\'s job row alone', async () => {
    let parked!: () => void
    const firstSweepParked = new Promise<void>((resolve) => { parked = resolve })
    let release!: () => void
    const releaseFirstSweep = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    mockUpsertIndexBatch.mockImplementation(async (_db, _entityType, rows) => {
      calls += 1
      if (calls === 2) {
        parked()
        await releaseFirstSweep
      }
      return written(rows.length)
    })

    const first = reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG, batchSize: 1 })
    await firstSweepParked
    const before = await readJob(ORG)

    const second = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG, batchSize: 1 })
    const during = await readJob(ORG)

    release()
    const firstResult = await first
    const after = await readJob(ORG)

    expect(before).toMatchObject({ processed_count: 1, finished_at: null })
    expect(second).toEqual({ processed: 0, total: 0, tenantScopes: [], scopes: [] })
    expect(during).toEqual(before)
    expect(firstResult.processed).toBe(2)
    expect(after?.processed_count).toBe(2)
    expect(after?.started_at).toEqual(before?.started_at)
    expect(after?.finished_at).not.toBeNull()
  })

  it('an unfinished organization-less job of the same tenant does not hold back the organization\'s sweep', async () => {
    await sql`insert into entity_index_jobs (entity_type, organization_id, tenant_id, status, started_at, heartbeat_at)
      values (${ENTITY}, null, ${TENANT}::uuid, 'reindexing', now(), now())`.execute(db)

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })

    expect(result.processed).toBe(2)
    expect((await readJob(ORG))?.finished_at).not.toBeNull()
  })

  it('takes the scope over from a job of the same organization whose worker died', async () => {
    await sql`insert into entity_index_jobs (entity_type, organization_id, tenant_id, status, started_at, heartbeat_at, processed_count)
      values (${ENTITY}, ${ORG}::uuid, ${TENANT}::uuid, 'reindexing', now() - interval '1 hour', now() - interval '1 hour', 1)`.execute(db)

    const result = await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })
    const job = await readJob(ORG)

    expect(result.processed).toBe(2)
    expect(job?.processed_count).toBe(2)
    expect(job?.finished_at).not.toBeNull()
  })

  it('dates the orphan purge from the organization\'s own job row', async () => {
    await sql`insert into entity_index_jobs (entity_type, organization_id, tenant_id, status, started_at, heartbeat_at, finished_at)
      values (${ENTITY}, null, ${TENANT}::uuid, 'reindexing', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day')`.execute(db)

    await reindexEntity(em, { entityType: ENTITY, tenantId: TENANT, organizationId: ORG })
    const own = await readJob(ORG)

    expect(mockPurgeOrphans).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, startedAt: own?.started_at }),
    )
  })
})
