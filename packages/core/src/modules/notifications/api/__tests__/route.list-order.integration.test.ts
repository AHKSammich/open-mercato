/** @jest-environment node */
import { randomUUID } from 'node:crypto'
import { MikroORM } from '@mikro-orm/core'
import { PostgreSqlDriver } from '@mikro-orm/postgresql'
import type { StartedTestContainer } from 'testcontainers'
import { Notification } from '../../data/entities'
import { GET } from '../route'

const mockResolveContext = jest.fn()

jest.mock('@open-mercato/core/modules/notifications/lib/routeHelpers', () => {
  const actual = jest.requireActual('@open-mercato/core/modules/notifications/lib/routeHelpers')
  return {
    ...actual,
    resolveGuardedNotificationContext: async () => ({ ok: true, ...mockResolveContext() }),
  }
})

const describeWithPostgres = process.env.OM_PG_INTEGRATION === '1' ? describe : describe.skip

type ListBody = { items: Array<{ id: string }>; total: number; totalPages: number }

describeWithPostgres('notifications list paging against PostgreSQL', () => {
  let postgres: StartedTestContainer | undefined
  let orm: MikroORM<PostgreSqlDriver> | undefined

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers')
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_DB: 'notifications', POSTGRES_USER: 'notifications', POSTGRES_PASSWORD: 'notifications' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start()
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      entities: [Notification],
      host: postgres.getHost(),
      port: postgres.getMappedPort(5432),
      dbName: 'notifications', user: 'notifications', password: 'notifications',
    })
    await orm.schema.create()
  }, 120_000)

  afterAll(async () => {
    await orm?.close(true)
    await postgres?.stop()
  }, 30_000)

  it('returns every notification exactly once when walking pages over a shared createdAt', async () => {
    const activeOrm = orm
    if (!activeOrm) throw new Error('[internal] PostgreSQL test ORM unavailable')
    const tenantId = randomUUID()
    const organizationId = randomUUID()
    const userId = randomUUID()
    const createdAt = new Date('2026-01-15T10:00:00.000Z')
    const em = activeOrm.em.fork()
    try {
      const rows = Array.from({ length: 30 }, (_, index) => em.create(Notification, {
        recipientUserId: userId,
        type: 'test.bulk',
        title: `Bulk ${index}`,
        tenantId,
        organizationId,
        createdAt,
      }))
      await em.flush()
      await em.nativeUpdate(Notification, { tenantId, recipientUserId: userId }, { createdAt })
      await em.getConnection().execute('analyze notifications')
      const seededIds = rows.map((row) => row.id).sort((left, right) => left.localeCompare(right))
      mockResolveContext.mockImplementation(() => ({
        ctx: {
          container: {
            resolve: (key: string) => {
              if (key === 'em') return activeOrm.em.fork({ clear: true })
              throw new Error(`[internal] unexpected resolve(${key})`)
            },
          },
        },
        scope: { userId, tenantId, organizationId, organizationIds: [organizationId] },
      }))

      const walkedIds: string[] = []
      for (let page = 1; page <= 6; page += 1) {
        const response = await GET(new Request(`http://localhost/api/notifications?page=${page}&pageSize=5`))
        expect(response.status).toBe(200)
        const body = (await response.json()) as ListBody
        expect(body.total).toBe(30)
        expect(body.totalPages).toBe(6)
        walkedIds.push(...body.items.map((item) => item.id))
      }

      expect(walkedIds).toHaveLength(30)
      expect([...walkedIds].sort((left, right) => left.localeCompare(right))).toEqual(seededIds)
    } finally {
      await em.nativeDelete(Notification, { tenantId, recipientUserId: userId })
    }
  }, 30_000)
})
