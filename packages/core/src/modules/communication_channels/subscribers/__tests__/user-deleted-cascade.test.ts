const emitCommunicationChannelsEvent = jest.fn()

jest.mock('../../events', () => ({
  emitCommunicationChannelsEvent: (...args: unknown[]) => emitCommunicationChannelsEvent(...args),
}))

import handler, { metadata } from '../user-deleted-cascade'

const TENANT = 'tenant-1'
const HOME_ORG = 'org-home'
const OTHER_ORG = 'org-other'

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch-1',
    userId: 'user-1',
    tenantId: TENANT,
    organizationId: HOME_ORG,
    providerKey: 'gmail',
    channelType: 'email',
    status: 'connected',
    isActive: true,
    isPrimary: true,
    credentialsRef: 'cred-1',
    lastError: null,
    lastPolledAt: null,
    ...overrides,
  }
}

function makeCtx(em: { find: jest.Mock; flush: jest.Mock }, envelope: { tenantId?: string | null } = {}) {
  return {
    resolve: <T>(name: string): T => {
      if (name === 'em') return { fork: () => em } as unknown as T
      return null as unknown as T
    },
    ...envelope,
  }
}

function deletedUserPayload(overrides: Record<string, unknown> = {}) {
  return { id: 'user-1', organizationId: HOME_ORG, tenantId: TENANT, ...overrides }
}

describe('user-deleted-cascade subscriber metadata', () => {
  it('subscribes to auth.user.deleted with a stable id', () => {
    expect(metadata.event).toBe('auth.user.deleted')
    expect(metadata.persistent).toBe(true)
    expect(metadata.id).toBe('communication_channels:user-deleted-cascade')
  })
})

describe('user-deleted-cascade subscriber behaviour', () => {
  beforeEach(() => {
    emitCommunicationChannelsEvent.mockReset()
  })

  it('no-ops when the payload carries no user id', async () => {
    const find = jest.fn()
    const flush = jest.fn()
    await handler({ organizationId: HOME_ORG, tenantId: TENANT } as never, makeCtx({ find, flush }))
    expect(find).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('no-ops (fail-closed) when neither the payload nor the event envelope carries a tenant', async () => {
    const find = jest.fn()
    const flush = jest.fn()
    await handler(deletedUserPayload({ tenantId: null }) as never, makeCtx({ find, flush }))
    expect(find).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('no-ops when the user has no channels', async () => {
    const find = jest.fn().mockResolvedValueOnce([])
    const flush = jest.fn()
    await handler(deletedUserPayload() as never, makeCtx({ find, flush }))
    expect(find).toHaveBeenCalledTimes(1)
    expect(flush).not.toHaveBeenCalled()
  })

  it('reads the user id the auth.user.deleted event emits and scopes the lookup by tenant only', async () => {
    const find = jest.fn().mockResolvedValueOnce([])
    const flush = jest.fn()
    await handler(deletedUserPayload() as never, makeCtx({ find, flush }))
    expect(find).toHaveBeenCalledTimes(1)
    const where = find.mock.calls[0][1] as Record<string, unknown>
    expect(where).toMatchObject({ userId: 'user-1', tenantId: TENANT, deletedAt: null })
    expect(where).not.toHaveProperty('organizationId')
  })

  it('prefers the event envelope tenant over the payload tenant', async () => {
    const find = jest.fn().mockResolvedValueOnce([])
    const flush = jest.fn()
    await handler(deletedUserPayload({ tenantId: 'tenant-from-payload' }) as never, makeCtx({ find, flush }, { tenantId: TENANT }))
    expect(find).toHaveBeenCalledTimes(1)
    expect((find.mock.calls[0][1] as Record<string, unknown>).tenantId).toBe(TENANT)
  })

  it('disconnects every channel the user owns, in any organization of the tenant', async () => {
    const channelA = makeChannel({ id: 'ch-a' })
    const channelB = makeChannel({ id: 'ch-b', isPrimary: false, organizationId: OTHER_ORG })
    const find = jest.fn().mockResolvedValueOnce([channelA, channelB])
    const flush = jest.fn()
    await handler(deletedUserPayload() as never, makeCtx({ find, flush }))
    expect(flush).toHaveBeenCalledTimes(1)
    for (const channel of [channelA, channelB]) {
      expect(channel.status).toBe('disconnected')
      expect(channel.isActive).toBe(false)
      expect(channel.isPrimary).toBe(false)
      expect(channel.credentialsRef).toBeNull()
      expect(channel.lastError).toBe('user-deleted')
      expect(channel.lastPolledAt).toBeInstanceOf(Date)
    }
  })

  it('emits communication_channels.channel.disconnected for each channel after the flush', async () => {
    const order: string[] = []
    const channelA = makeChannel({ id: 'ch-a' })
    const channelB = makeChannel({ id: 'ch-b', organizationId: OTHER_ORG })
    const find = jest.fn().mockResolvedValueOnce([channelA, channelB])
    const flush = jest.fn(async () => {
      order.push('flush')
    })
    emitCommunicationChannelsEvent.mockImplementation(async () => {
      order.push('emit')
    })
    await handler(deletedUserPayload() as never, makeCtx({ find, flush }))
    expect(order).toEqual(['flush', 'emit', 'emit'])
    expect(emitCommunicationChannelsEvent).toHaveBeenCalledWith(
      'communication_channels.channel.disconnected',
      {
        channelId: 'ch-b',
        userId: 'user-1',
        providerKey: 'gmail',
        channelType: 'email',
        tenantId: TENANT,
        organizationId: OTHER_ORG,
      },
      { persistent: true },
    )
  })

  it('is idempotent — already-disconnected channels are not re-flushed', async () => {
    const already = makeChannel({
      id: 'ch-c',
      status: 'disconnected',
      isActive: false,
      isPrimary: false,
      credentialsRef: null,
    })
    const find = jest.fn().mockResolvedValueOnce([already])
    const flush = jest.fn()
    await handler(deletedUserPayload() as never, makeCtx({ find, flush }))
    expect(flush).not.toHaveBeenCalled()
    expect(emitCommunicationChannelsEvent).not.toHaveBeenCalled()
  })
})
