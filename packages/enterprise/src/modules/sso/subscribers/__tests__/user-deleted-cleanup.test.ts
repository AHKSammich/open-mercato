import handle, { metadata } from '../user-deleted-cleanup'
import { SsoIdentity, SsoRoleGrant, SsoUserDeactivation } from '../../data/entities'

const TENANT = 'tenant-1'

type Call = { op: 'nativeUpdate' | 'nativeDelete'; entity: unknown; where: Record<string, unknown>; data?: Record<string, unknown> }

function makeCtx(envelope: { tenantId?: string | null } = {}) {
  const calls: Call[] = []
  const tx = {
    nativeUpdate: jest.fn(async (entity: unknown, where: Record<string, unknown>, data: Record<string, unknown>) => {
      calls.push({ op: 'nativeUpdate', entity, where, data })
      return 1
    }),
    nativeDelete: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      calls.push({ op: 'nativeDelete', entity, where })
      return 1
    }),
  }
  const forked = {
    transactional: jest.fn(async (cb: (em: typeof tx) => Promise<unknown>) => cb(tx)),
  }
  const requestEm = {
    fork: jest.fn(() => forked),
    transactional: jest.fn(async (cb: (em: typeof tx) => Promise<unknown>) => cb(tx)),
  }
  const ctx = {
    resolve: <T>(name: string): T => (name === 'em' ? (requestEm as unknown as T) : (null as unknown as T)),
    ...envelope,
  }
  return { ctx, calls, requestEm, forked }
}

function scopedTo(userId: string, tenantId: string) {
  return { userId, $or: [{ tenantId }, { tenantId: null }] }
}

describe('sso user-deleted-cleanup subscriber', () => {
  it('subscribes to auth.user.deleted with a stable id', () => {
    expect(metadata.event).toBe('auth.user.deleted')
    expect(metadata.persistent).toBe(true)
    expect(metadata.id).toBe('sso:user-deleted-cleanup')
  })

  it('cleans up the identities and role grants of the user id the event emits, scoped to the tenant', async () => {
    const { ctx, calls } = makeCtx()
    await handle({ id: 'user-1', organizationId: 'org-1', tenantId: TENANT } as never, ctx)

    const identityUpdate = calls.find((call) => call.op === 'nativeUpdate' && call.entity === SsoIdentity)
    expect(identityUpdate?.where).toEqual({ ...scopedTo('user-1', TENANT), deletedAt: null })
    expect(identityUpdate?.data?.deletedAt).toBeInstanceOf(Date)

    const grantDelete = calls.find((call) => call.op === 'nativeDelete' && call.entity === SsoRoleGrant)
    expect(grantDelete?.where).toEqual(scopedTo('user-1', TENANT))

    for (const call of calls) {
      expect(call.where.userId).toBe('user-1')
      expect(call.where).not.toHaveProperty('organizationId')
    }
  })

  it('keeps the SCIM deactivation record of the deleted user', async () => {
    const { ctx, calls } = makeCtx()
    await handle({ id: 'user-1', organizationId: 'org-1', tenantId: TENANT } as never, ctx)
    expect(calls.some((call) => call.entity === SsoUserDeactivation)).toBe(false)
  })

  it('runs in a transaction on a forked entity manager', async () => {
    const { ctx, requestEm, forked } = makeCtx()
    await handle({ id: 'user-1', organizationId: 'org-1', tenantId: TENANT } as never, ctx)
    expect(requestEm.fork).toHaveBeenCalledTimes(1)
    expect(forked.transactional).toHaveBeenCalledTimes(1)
    expect(requestEm.transactional).not.toHaveBeenCalled()
  })

  it('prefers the event envelope tenant over the payload tenant', async () => {
    const { ctx, calls } = makeCtx({ tenantId: TENANT })
    await handle({ id: 'user-1', organizationId: 'org-1', tenantId: 'tenant-from-payload' } as never, ctx)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.where.$or).toEqual([{ tenantId: TENANT }, { tenantId: null }])
    }
  })

  it('issues no statement when the payload carries no user id', async () => {
    const { ctx, calls, requestEm } = makeCtx()
    await handle({ organizationId: 'org-1', tenantId: TENANT } as never, ctx)
    expect(calls).toEqual([])
    expect(requestEm.fork).not.toHaveBeenCalled()
  })

  it('issues no statement (fail-closed) when no tenant is known', async () => {
    const { ctx, calls } = makeCtx()
    await handle({ id: 'user-1', organizationId: 'org-1', tenantId: null } as never, ctx)
    expect(calls).toEqual([])
  })
})
