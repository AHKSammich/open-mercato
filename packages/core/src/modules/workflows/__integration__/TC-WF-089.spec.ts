import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-WF-089 [P2]: malformed request body on the instance signal route
 *
 * Surfaces under test:
 * - POST /api/workflows/instances/[id]/signal
 *
 * A body that is empty or not valid JSON is a client error and answers 400 like a body
 * failing the schema, instead of a 500. The body is rejected before the instance is looked up,
 * so no fixtures are needed; a well-formed body for the same unknown instance still reaches the
 * lookup and answers 404.
 */
test.describe('TC-WF-089: instance signal route rejects a malformed body with 400', () => {
  test('answers 400 for invalid JSON and an empty body, 404 for a valid body on an unknown instance', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const path = `/api/workflows/instances/${randomUUID()}/signal`

    const malformed = await apiRequest(request, 'POST', path, { token, data: '{not valid json' })
    expect(malformed.status()).toBe(400)
    const malformedBody = await readJsonSafe<{ error?: string }>(malformed)
    expect(malformedBody?.error).toBe('Invalid request body')

    const empty = await apiRequest(request, 'POST', path, { token, data: '' })
    expect(empty.status()).toBe(400)
    const emptyBody = await readJsonSafe<{ error?: string }>(empty)
    expect(emptyBody?.error).toBe('Invalid request body')

    const unknownInstance = await apiRequest(request, 'POST', path, {
      token,
      data: { signalName: 'approval' },
    })
    expect(unknownInstance.status()).toBe(404)
  })
})
