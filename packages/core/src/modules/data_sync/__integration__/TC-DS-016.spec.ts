import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'

/**
 * TC-DS-016: the field mapping list returns every mapping exactly once when
 * walked page by page, even when mappings share createdAt.
 *
 * Postgres sorts each limit/offset page on its own, so rows tied on the only
 * sort key come back in a different relative order per page unless the query
 * adds a unique tiebreak. The mappings are created through the API; only their
 * created_at is set to one shared value so the tie is deterministic.
 */

const ROW_COUNT = 12
const PAGE_SIZE = 2

type ListBody = {
  items?: Array<{ id?: string }>
  total?: number
}

async function walkPages(request: APIRequestContext, token: string, integrationId: string): Promise<string[]> {
  const ids: string[] = []
  for (let page = 1; page <= ROW_COUNT / PAGE_SIZE; page += 1) {
    const response = await apiRequest(
      request,
      'GET',
      `/api/data_sync/mappings?integrationId=${encodeURIComponent(integrationId)}&page=${page}&pageSize=${PAGE_SIZE}`,
      { token },
    )
    expect(response.status()).toBe(200)
    const body = await readJsonSafe<ListBody>(response)
    expect(body?.total).toBe(ROW_COUNT)
    for (const row of body?.items ?? []) {
      if (row.id) ids.push(row.id)
    }
  }
  return ids
}

test.describe('TC-DS-016: field mapping list pagination stays stable when createdAt ties', () => {
  test('mapping list pages return every tied mapping exactly once', async ({ request }) => {
    test.setTimeout(60_000)
    const token = await getAuthToken(request, 'admin')
    const integrationId = `qa_ds_016_${Date.now()}`
    const mappingIds: string[] = []
    try {
      for (let index = 0; index < ROW_COUNT; index += 1) {
        const response = await apiRequest(request, 'POST', '/api/data_sync/mappings', {
          token,
          data: { integrationId, entityType: `qa.entity_${index}`, mapping: { index } },
        })
        const body = await readJsonSafe<{ id?: string }>(response)
        if (body?.id) mappingIds.push(body.id)
        expect(response.status()).toBe(201)
        expect(typeof body?.id).toBe('string')
      }

      await withClient(async (client) => {
        await client.query(
          'update sync_mappings set created_at = (select min(created_at) from sync_mappings where id = any($1::uuid[])) where id = any($1::uuid[])',
          [mappingIds],
        )
      })

      const firstWalk = await walkPages(request, token, integrationId)
      expect(new Set(firstWalk).size).toBe(ROW_COUNT)
      expect([...firstWalk].sort()).toEqual([...mappingIds].sort())
      expect(await walkPages(request, token, integrationId)).toEqual(firstWalk)
    } finally {
      for (const mappingId of mappingIds) {
        await apiRequest(request, 'DELETE', `/api/data_sync/mappings/${encodeURIComponent(mappingId)}`, { token }).catch(() => undefined)
      }
    }
  })
})
