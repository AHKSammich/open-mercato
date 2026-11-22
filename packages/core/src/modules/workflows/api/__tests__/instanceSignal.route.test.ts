/**
 * Instance signal route: a body that is empty or not valid JSON is a client error.
 *
 * The route used to read the body with an unguarded `request.json()`, so the parse failure
 * reached the generic handler and answered 500. It now gets the same 400 a body failing the
 * schema gets, and the signal is never sent.
 */

import { NextRequest } from 'next/server'

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(),
}))

jest.mock('../../lib/signal-handler', () => ({
  sendSignal: jest.fn(),
}))

import { POST as sendSignalToInstance } from '../instances/[id]/signal/route'
import { sendSignal } from '../../lib/signal-handler'

const mockSendSignal = sendSignal as jest.MockedFunction<typeof sendSignal>

const testTenantId = 'tenant-1'
const testOrgId = 'org-1'
const instanceId = '11111111-1111-4111-8111-111111111111'

function makeRequest(body: string): NextRequest {
  return new NextRequest(`http://localhost/api/workflows/instances/${instanceId}/signal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function callRoute(body: string) {
  return sendSignalToInstance(makeRequest(body), { params: Promise.resolve({ id: instanceId }) })
}

describe('POST /api/workflows/instances/[id]/signal request body', () => {
  const mockEm = {}

  beforeEach(() => {
    jest.clearAllMocks()

    const { createRequestContainer } = require('@open-mercato/shared/lib/di/container')
    createRequestContainer.mockResolvedValue({
      resolve: (name: string) =>
        name === 'em'
          ? mockEm
          : name === 'rbacService'
            ? { userHasAllFeatures: jest.fn().mockResolvedValue(true) }
            : null,
    })

    const { getAuthFromRequest } = require('@open-mercato/shared/lib/auth/server')
    getAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: testTenantId, orgId: testOrgId })

    const { resolveOrganizationScopeForRequest } = require('@open-mercato/core/modules/directory/utils/organizationScope')
    resolveOrganizationScopeForRequest.mockResolvedValue({ selectedId: testOrgId })
  })

  it('returns 400 for a body that is not valid JSON', async () => {
    const response = await callRoute('{not valid json')
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid request body')
    expect(mockSendSignal).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty body', async () => {
    const response = await callRoute('')
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid request body')
    expect(mockSendSignal).not.toHaveBeenCalled()
  })

  it('still returns 400 for valid JSON that fails the schema', async () => {
    const response = await callRoute(JSON.stringify({}))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid request body')
    expect(mockSendSignal).not.toHaveBeenCalled()
  })

  it('sends the signal for a valid body', async () => {
    mockSendSignal.mockResolvedValueOnce(undefined)

    const response = await callRoute(JSON.stringify({ signalName: 'approval', payload: { approved: true } }))

    expect(response.status).toBe(200)
    expect(mockSendSignal).toHaveBeenCalledWith(mockEm, expect.anything(), {
      instanceId,
      signalName: 'approval',
      payload: { approved: true },
      userId: 'user-1',
      tenantId: testTenantId,
      organizationId: testOrgId,
    })
  })
})
