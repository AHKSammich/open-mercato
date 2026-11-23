/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import type { StartedTestContainer } from 'testcontainers'
import { CommunicationChannel } from '../../../../data/entities'
import { GET } from '../route'

const mockResolve = jest.fn()
const mockGetAuth = jest.fn()

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: mockResolve })),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => mockGetAuth(...args),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: async () => null,
}))

const describeWithPostgres = process.env.OM_PG_INTEGRATION === '1' ? describe : describe.skip

type ListBody = { items: Array<{ id: string }>; total: number; totalPages: number }

describeWithPostgres('communication channels list paging against PostgreSQL', () => {
  let postgres: StartedTestContainer | undefined
  let orm: MikroORM<PostgreSqlDriver> | undefined

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers')
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_DB: 'channels', POSTGRES_USER: 'channels', POSTGRES_PASSWORD: 'channels' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start()
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      entities: [CommunicationChannel],
      host: postgres.getHost(),
      port: postgres.getMappedPort(5432),
      dbName: 'channels', user: 'channels', password: 'channels',
    })
    await orm.schema.create()
  }, 120_000)

  afterAll(async () => {
    await orm?.close(true)
    await postgres?.stop()
  }, 30_000)

  it('returns every channel exactly once when walking pages over a shared createdAt', async () => {
    const activeOrm = orm
    if (!activeOrm) throw new Error('[internal] PostgreSQL test ORM unavailable')
    const tenantId = randomUUID()
    const organizationId = randomUUID()
    const createdAt = new Date('2026-11-15T10:00:00.000Z')
    const em = activeOrm.em.fork()
    try {
      const rows = Array.from({ length: 30 }, (_, index) => em.create(CommunicationChannel, {
        tenantId,
        organizationId,
        userId: null,
        providerKey: 'imap',
        channelType: 'email',
        displayName: `Shared inbox ${index}`,
        createdAt,
        updatedAt: createdAt,
      }))
      await em.flush()
      const seededIds = rows.map((row) => row.id).sort()
      await em.getConnection().execute('analyze communication_channels')
      mockGetAuth.mockResolvedValue({ sub: randomUUID(), tenantId, orgId: organizationId })
      mockResolve.mockImplementation((key: string) => {
        if (key === 'em') return activeOrm.em.fork({ clear: true })
        throw new Error(`[internal] unexpected resolve(${key})`)
      })

      const walkedIds: string[] = []
      for (let page = 1; page <= 6; page += 1) {
        const response = await GET(new Request(`http://localhost/api/communication_channels/channels?page=${page}&pageSize=5`))
        expect(response.status).toBe(200)
        const body = (await response.json()) as ListBody
        expect(body.total).toBe(30)
        expect(body.totalPages).toBe(6)
        walkedIds.push(...body.items.map((item) => item.id))
      }

      expect(walkedIds).toHaveLength(30)
      expect([...walkedIds].sort()).toEqual(seededIds)
    } finally {
      await em.nativeDelete(CommunicationChannel, { tenantId })
    }
  }, 30_000)
})
