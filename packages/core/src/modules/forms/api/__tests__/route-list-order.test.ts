/** @jest-environment node */

const mockResolve = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: mockResolve })),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => ({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' })),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(async () => null),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key })),
}))

type RouteModule = typeof import('../route')
let listHandler: RouteModule['GET']

beforeAll(async () => {
  listHandler = (await import('../route')).GET
})

describe('forms list route', () => {
  const findAndCount = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    findAndCount.mockResolvedValue([[], 0])
    mockResolve.mockImplementation((token: string) => {
      if (token === 'em') return { findAndCount, find: jest.fn(async () => []) }
      throw new Error(`[internal] unexpected resolve(${token})`)
    })
  })

  it('breaks updatedAt ties by id so offset pages stay stable', async () => {
    const response = await listHandler(new Request('http://localhost/api/forms?page=2&pageSize=25'))

    expect(response.status).toBe(200)
    const options = findAndCount.mock.calls[0][2] as { orderBy: Record<string, string>; limit: number; offset: number }
    expect(options.orderBy).toEqual({ updatedAt: 'desc', id: 'desc' })
    expect(Object.keys(options.orderBy)).toEqual(['updatedAt', 'id'])
    expect(options.limit).toBe(25)
    expect(options.offset).toBe(25)
  })
})
