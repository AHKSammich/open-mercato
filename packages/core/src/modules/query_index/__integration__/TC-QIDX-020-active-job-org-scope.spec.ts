import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'

/**
 * TC-QIDX-020: a non-forced reindex must not run over an unfinished sweep of the same
 * organization.
 *
 * `/api/query_index/reindex` always queues an organization-scoped sweep, and `prepareJob`
 * files its `entity_index_jobs` row under that organization. The active-job guard used to
 * look for an organization-less row instead, so it never saw the running sweep: the second
 * sweep reset the running row's `started_at` and `processed_count` through the upsert and
 * then finalized it while the first sweep was still writing.
 *
 * The spec stands in for the running sweep with a live (fresh heartbeat) job row of the
 * caller's organization, queues a non-forced reindex, and reads back both the row and the
 * subscriber's completion log. The control half deletes that row and queues the same reindex
 * again, proving the lane really runs the sweep it skipped.
 */

const ENTITY = 'customers:customer_entity'
const REINDEX_TIMEOUT_MS = 60_000
const EVENTS_QUEUE = 'events'
const SEEDED_PROCESSED = 7
const SEEDED_STARTED_AT = '2026-01-01T00:00:00.000Z'

type JobRow = { processed_count: number | null; started_at: Date; finished_at: Date | null }
type LogRow = { total: string | null; processed: string | null }

async function readScopeJob(tenantId: string, organizationId: string): Promise<JobRow | undefined> {
  return withClient(async (client) => (await client.query<JobRow>(
    `select processed_count, started_at, finished_at from entity_index_jobs
      where entity_type = $1 and tenant_id = $2 and organization_id = $3
        and partition_index is null and partition_count is null`,
    [ENTITY, tenantId, organizationId],
  )).rows[0])
}

async function latestCompletion(tenantId: string, organizationId: string, since: Date): Promise<LogRow | null> {
  return withClient(async (client) => (await client.query<LogRow>(
    `select details->>'total' as total, details->>'processed' as processed from indexer_status_logs
      where handler = 'event:query_index.reindex' and entity_type = $1
        and tenant_id = $2 and organization_id = $3
        and message like 'Reindex completed%' and occurred_at >= $4
      order by occurred_at desc limit 1`,
    [ENTITY, tenantId, organizationId, since],
  )).rows[0] ?? null)
}

async function deleteScopeJob(tenantId: string, organizationId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `delete from entity_index_jobs
        where entity_type = $1 and tenant_id = $2 and organization_id = $3
          and partition_index is null and partition_count is null`,
      [ENTITY, tenantId, organizationId],
    )
  })
}

async function queueReindex(request: APIRequestContext, token: string): Promise<Date> {
  const since = await withClient(async (client) => (await client.query<{ now: Date }>('select now() as now')).rows[0].now)
  const response = await apiRequest(request, 'POST', '/api/query_index/reindex', {
    token,
    data: { entityType: ENTITY },
  })
  expect(response.ok(), `POST /api/query_index/reindex: ${response.status()}`).toBeTruthy()
  await drainIntegrationQueue(EVENTS_QUEUE)
  return since
}

test.describe('TC-QIDX-020: reindex active-job guard honours the organization scope', () => {
  test('a non-forced reindex skips a running sweep of the same organization', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    let companyId: string | null = null

    try {
      companyId = await createCompanyFixture(request, token, `QA TC-QIDX-020 ${Date.now()}`)
      await deleteScopeJob(tenantId, organizationId)
      await withClient(async (client) => {
        await client.query(
          `insert into entity_index_jobs
            (entity_type, organization_id, tenant_id, partition_index, partition_count, status,
             started_at, heartbeat_at, processed_count, total_count)
            values ($1, $2, $3, null, null, 'reindexing', $4, now(), $5, $5)`,
          [ENTITY, organizationId, tenantId, SEEDED_STARTED_AT, SEEDED_PROCESSED],
        )
      })

      const skippedSince = await queueReindex(request, token)
      await expect.poll(() => latestCompletion(tenantId, organizationId, skippedSince), { timeout: REINDEX_TIMEOUT_MS })
        .toEqual({ total: '0', processed: '0' })
      const running = await readScopeJob(tenantId, organizationId)
      expect(running?.processed_count).toBe(SEEDED_PROCESSED)
      expect(running?.started_at.toISOString()).toBe(SEEDED_STARTED_AT)
      expect(running?.finished_at).toBeNull()

      await deleteScopeJob(tenantId, organizationId)
      const controlSince = await queueReindex(request, token)
      await expect.poll(async () => {
        const log = await latestCompletion(tenantId, organizationId, controlSince)
        return log ? Number(log.total) : null
      }, { timeout: REINDEX_TIMEOUT_MS }).toBeGreaterThan(0)
      expect((await readScopeJob(tenantId, organizationId))?.finished_at).not.toBeNull()
    } finally {
      await deleteScopeJob(tenantId, organizationId).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})
