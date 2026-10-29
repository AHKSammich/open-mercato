jest.mock('@open-mercato/shared/lib/commands/helpers', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/commands/helpers')
  return {
    ...actual,
    emitCrudSideEffects: jest.fn(async () => {}),
    emitCrudUndoSideEffects: jest.fn(async () => {}),
  }
})

jest.mock('../events', () => ({
  emitDevicesEvent: jest.fn(async () => {}),
}))

const mockFindOneWithDecryption = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn((...args: unknown[]) => mockFindOneWithDecryption(...args)),
  findWithDecryption: jest.fn(async () => []),
}))

import '../commands/register'
import '../commands/update'
import '../commands/deactivate'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEVICE_ROW_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'

type ScopeOptions = {
  allowedIds: string[] | null
  isSuperAdmin?: boolean
  selectedId?: string | null
  homeOrgId?: string | null
  withoutScope?: boolean
}

function makeEm() {
  const em: Record<string, unknown> = {
    fork: () => em,
    flush: jest.fn(async () => {}),
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
    persist: jest.fn(),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: DEVICE_ROW_ID, ...data })),
  }
  return em
}

function makeCtx({
  allowedIds,
  isSuperAdmin = false,
  selectedId = ORG_A,
  homeOrgId = ORG_A,
  withoutScope = false,
}: ScopeOptions): CommandRuntimeContext {
  const em = makeEm()
  const container = {
    resolve: (token: string) => {
      if (token === 'em') return em
      if (token === 'dataEngine') return { markOrmEntityChange: jest.fn() }
      throw new Error(`[internal] unexpected dependency: ${token}`)
    },
  }
  return {
    container: container as never,
    auth: { sub: 'actor-1', tenantId: TENANT, orgId: homeOrgId, isSuperAdmin } as never,
    organizationScope: withoutScope
      ? null
      : ({ selectedId, tenantId: TENANT, allowedIds, filterIds: allowedIds } as never),
    selectedOrganizationId: selectedId,
    organizationIds: allowedIds,
    request: undefined as never,
  }
}

function getHandler(id: string): CommandHandler<Record<string, unknown>, Record<string, unknown>> {
  const handler = commandRegistry.get<Record<string, unknown>, Record<string, unknown>>(id)
  expect(handler).toBeDefined()
  return handler as CommandHandler<Record<string, unknown>, Record<string, unknown>>
}

function makeDevice(organizationId: string | null) {
  return {
    id: DEVICE_ROW_ID,
    tenantId: TENANT,
    organizationId,
    userId: USER_ID,
    deviceId: 'install-1',
    platform: 'ios',
    deletedAt: null,
    clientAppVersion: null,
    osVersion: null,
    locale: null,
    pushToken: null,
    pushTokenUpdatedAt: null,
    pushProvider: null,
    lastSeenAt: new Date(),
  }
}

function updateInput(organizationId: string | null) {
  return { id: DEVICE_ROW_ID, tenantId: TENANT, userId: USER_ID, organizationId, locale: 'en-US' }
}

function registerInput(organizationId: string | null) {
  return { tenantId: TENANT, organizationId, userId: USER_ID, deviceId: 'install-1', platform: 'ios' }
}

beforeEach(() => {
  mockFindOneWithDecryption.mockReset()
})

describe('devices commands enforce the caller organization scope', () => {
  describe('devices.user_devices.deactivate (existing guard)', () => {
    test('rejects an org-A caller acting on an org-B device', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(ORG_B))
      await expect(
        getHandler('devices.user_devices.deactivate').execute(
          { id: DEVICE_ROW_ID, tenantId: TENANT, userId: USER_ID },
          makeCtx({ allowedIds: [ORG_A] }),
        ),
      ).rejects.toMatchObject({ status: 403 })
    })
  })

  describe('devices.user_devices.update', () => {
    test('execute rejects an org-A caller mutating an org-B device in the same tenant', async () => {
      const device = makeDevice(ORG_B)
      mockFindOneWithDecryption.mockResolvedValue(device)
      await expect(
        getHandler('devices.user_devices.update').execute(updateInput(ORG_B), makeCtx({ allowedIds: [ORG_A] })),
      ).rejects.toMatchObject({ status: 403 })
      expect(device.locale).toBeNull()
    })

    test('prepare rejects the cross-organization snapshot lookup', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(ORG_B))
      const handler = getHandler('devices.user_devices.update')
      await expect(handler.prepare!(updateInput(ORG_B), makeCtx({ allowedIds: [ORG_A] }))).rejects.toMatchObject({
        status: 403,
      })
    })

    test('rejects a restricted caller whose account organization is outside the allowed scope', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(ORG_B))
      await expect(
        getHandler('devices.user_devices.update').execute(
          updateInput(ORG_B),
          makeCtx({ allowedIds: [ORG_A], selectedId: null, homeOrgId: ORG_B }),
        ),
      ).rejects.toMatchObject({ status: 403 })
    })

    test('prepare returns no snapshot for a missing device', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      await expect(
        getHandler('devices.user_devices.update').prepare!(updateInput(ORG_B), makeCtx({ allowedIds: [ORG_A] })),
      ).resolves.toEqual({})
    })

    test('a scope-less system context is constrained to its selected organization', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(ORG_B))
      const handler = getHandler('devices.user_devices.update')
      await expect(
        handler.execute(updateInput(ORG_B), makeCtx({ allowedIds: null, withoutScope: true, selectedId: ORG_A })),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        handler.execute(updateInput(ORG_B), makeCtx({ allowedIds: null, withoutScope: true, selectedId: ORG_B })),
      ).resolves.toEqual({ id: DEVICE_ROW_ID })
    })

    test('still updates a device in an allowed organization', async () => {
      const device = makeDevice(ORG_A)
      mockFindOneWithDecryption.mockResolvedValue(device)
      const handler = getHandler('devices.user_devices.update')
      const ctx = makeCtx({ allowedIds: [ORG_A] })
      await expect(handler.prepare!(updateInput(ORG_A), ctx)).resolves.toMatchObject({ before: { id: DEVICE_ROW_ID } })
      await expect(handler.execute(updateInput(ORG_A), ctx)).resolves.toEqual({ id: DEVICE_ROW_ID })
      expect(device.locale).toBe('en-US')
    })

    test('still updates a tenant-scoped device without an organization', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(null))
      await expect(
        getHandler('devices.user_devices.update').execute(updateInput(null), makeCtx({ allowedIds: [ORG_A] })),
      ).resolves.toEqual({ id: DEVICE_ROW_ID })
    })

    test('still updates any organization for an unrestricted caller', async () => {
      mockFindOneWithDecryption.mockResolvedValue(makeDevice(ORG_B))
      await expect(
        getHandler('devices.user_devices.update').execute(updateInput(ORG_B), makeCtx({ allowedIds: null })),
      ).resolves.toEqual({ id: DEVICE_ROW_ID })
    })
  })

  describe('devices.user_devices.register', () => {
    test('execute rejects registering a device under an organization outside the caller scope', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      const ctx = makeCtx({ allowedIds: [ORG_A] })
      await expect(
        getHandler('devices.user_devices.register').execute(registerInput(ORG_B), ctx),
      ).rejects.toMatchObject({ status: 403 })
      const em = ctx.container.resolve('em') as { persist: jest.Mock }
      expect(em.persist).not.toHaveBeenCalled()
      expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
    })

    test('rejects a restricted caller registering under an account organization outside the allowed scope', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      await expect(
        getHandler('devices.user_devices.register').execute(
          registerInput(ORG_B),
          makeCtx({ allowedIds: [ORG_A], selectedId: null, homeOrgId: ORG_B }),
        ),
      ).rejects.toMatchObject({ status: 403 })
    })

    test('execute rejects reviving an existing device in an organization outside the caller scope', async () => {
      const existing = { ...makeDevice(ORG_B), deletedAt: new Date() }
      mockFindOneWithDecryption.mockResolvedValue(existing)
      await expect(
        getHandler('devices.user_devices.register').execute(registerInput(ORG_B), makeCtx({ allowedIds: [ORG_A] })),
      ).rejects.toMatchObject({ status: 403 })
      expect(existing.deletedAt).not.toBeNull()
    })

    test('prepare rejects the cross-organization snapshot lookup before touching the database', async () => {
      await expect(
        getHandler('devices.user_devices.register').prepare!(registerInput(ORG_B), makeCtx({ allowedIds: [ORG_A] })),
      ).rejects.toMatchObject({ status: 403 })
      expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
    })

    test('still registers a device in an allowed organization', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      await expect(
        getHandler('devices.user_devices.register').execute(registerInput(ORG_A), makeCtx({ allowedIds: [ORG_A] })),
      ).resolves.toMatchObject({ id: DEVICE_ROW_ID, revived: false })
    })

    test('still registers a tenant-scoped device without an organization', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      await expect(
        getHandler('devices.user_devices.register').execute(registerInput(null), makeCtx({ allowedIds: [ORG_A] })),
      ).resolves.toMatchObject({ id: DEVICE_ROW_ID })
    })

    test('still registers in any organization for a super admin', async () => {
      mockFindOneWithDecryption.mockResolvedValue(null)
      await expect(
        getHandler('devices.user_devices.register').execute(
          registerInput(ORG_B),
          makeCtx({ allowedIds: [ORG_A], isSuperAdmin: true }),
        ),
      ).resolves.toMatchObject({ id: DEVICE_ROW_ID })
    })
  })
})
