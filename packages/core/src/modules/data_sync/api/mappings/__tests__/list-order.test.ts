/** @jest-environment node */

const mockGetAuthFromRequest = jest.fn()
const mockFindAndCountWithDecryption = jest.fn<Promise<[unknown[], number]>, unknown[]>()

const mockContainer = {
  resolve: jest.fn((token: string) => (token === 'em' ? {} : null)),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((req: Request) => mockGetAuthFromRequest(req)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findAndCountWithDecryption: jest.fn((...args: unknown[]) => mockFindAndCountWithDecryption(...args)),
  findOneWithDecryption: jest.fn(async () => null),
}))

import { GET } from '../route'

describe('data_sync mappings list order', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' })
    mockFindAndCountWithDecryption.mockResolvedValue([[], 0])
  })

  it('breaks createdAt ties by id so offset pages stay stable', async () => {
    const res = await GET(new Request('http://localhost/api/data_sync/mappings?page=2&pageSize=2'))

    expect(res.status).toBe(200)
    expect(mockFindAndCountWithDecryption).toHaveBeenCalledTimes(1)
    const [, , where, options] = mockFindAndCountWithDecryption.mock.calls[0]
    expect(where).toEqual({ organizationId: 'org-1', tenantId: 'tenant-1' })
    expect(options).toEqual({ orderBy: { createdAt: 'DESC', id: 'DESC' }, limit: 2, offset: 2 })
  })
})
