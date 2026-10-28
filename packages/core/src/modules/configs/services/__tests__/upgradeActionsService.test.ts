jest.mock('@open-mercato/shared/security/enabledModulesRegistry', () => ({
  getEnabledModuleIds: jest.fn(),
}))

process.env.UPGRADE_ACTIONS_ENABLED = 'true'

import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { getEnabledModuleIds } from '@open-mercato/shared/security/enabledModulesRegistry'
import { listPendingUpgradeActions, executeUpgradeAction } from '../upgradeActionsService'
import { upgradeActions, type UpgradeActionDefinition } from '../../lib/upgrade-actions'

const getEnabledModuleIdsMock = getEnabledModuleIds as jest.Mock

const TENANT_ID = '10000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000001'
const POST_COMMIT_ACTION_ID = 'test.post-commit-encryption-map-invalidation'

function createEm(runs: unknown[] = []) {
  return {
    find: jest.fn().mockResolvedValue(runs),
  } as any
}

describe('listPendingUpgradeActions module gating', () => {
  afterEach(() => {
    getEnabledModuleIdsMock.mockReset()
  })

  it('omits an action whose required module is disabled', async () => {
    getEnabledModuleIdsMock.mockReturnValue(['configs', 'customers', 'devices'])
    const em = createEm()

    const actions = await listPendingUpgradeActions(em, {
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      version: '0.6.6',
    })

    expect(actions.some((action) => action.id === 'payment_gateways.register-session-initialization-prune')).toBe(false)
  })

  it('includes the action once its required module is enabled', async () => {
    getEnabledModuleIdsMock.mockReturnValue(['configs', 'customers', 'devices', 'payment_gateways'])
    const em = createEm()

    const actions = await listPendingUpgradeActions(em, {
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      version: '0.6.6',
    })

    expect(actions.some((action) => action.id === 'payment_gateways.register-session-initialization-prune')).toBe(true)
  })

  it('fails closed (excludes gated actions) when the module registry is empty', async () => {
    getEnabledModuleIdsMock.mockReturnValue([])
    const em = createEm()

    const actions = await listPendingUpgradeActions(em, {
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      version: '0.6.6',
    })

    expect(actions.some((action) => action.id === 'payment_gateways.register-session-initialization-prune')).toBe(false)
  })
})

describe('executeUpgradeAction module gating', () => {
  afterEach(() => {
    getEnabledModuleIdsMock.mockReset()
    const actionIndex = upgradeActions.findIndex((action) => action.id === POST_COMMIT_ACTION_ID)
    if (actionIndex >= 0) upgradeActions.splice(actionIndex, 1)
  })

  it('rejects executing an action whose required module is disabled', async () => {
    getEnabledModuleIdsMock.mockReturnValue(['configs'])
    const container = {
      resolve: jest.fn(),
    } as any

    await expect(
      executeUpgradeAction(container, {
        actionId: 'payment_gateways.register-session-initialization-prune',
        tenantId: TENANT_ID,
        organizationId: ORGANIZATION_ID,
        version: '0.6.6',
      }),
    ).rejects.toThrow('UPGRADE_ACTION_NOT_AVAILABLE')
  })

  it('runs deferred cache invalidation only after the outer transaction commits', async () => {
    const order: string[] = []
    const action: UpgradeActionDefinition = {
      id: POST_COMMIT_ACTION_ID,
      version: '99.0.0',
      messageKey: 'test.message',
      ctaKey: 'test.cta',
      successKey: 'test.success',
      async run({ deferAfterCommit }) {
        order.push('map-write')
        deferAfterCommit?.(() => {
          order.push('cache-invalidation')
        })
      },
    }
    upgradeActions.push(action)
    const transactionalEm = {
      findOne: jest.fn(async () => null),
      create: jest.fn((_Entity: unknown, input: unknown) => input),
      persist: jest.fn(),
      flush: jest.fn(async () => {
        order.push('flush')
      }),
    }
    const em = {
      transactional: jest.fn(async (callback: (transactionalEm: typeof transactionalEm) => Promise<unknown>) => {
        const result = await callback(transactionalEm)
        order.push('commit')
        return result
      }),
    }
    const container = { resolve: jest.fn(() => em) } as never

    await expect(executeUpgradeAction(container, {
      actionId: POST_COMMIT_ACTION_ID,
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      version: '99.0.0',
    })).resolves.toMatchObject({ status: 'completed' })

    expect(order).toEqual(['flush', 'map-write', 'flush', 'commit', 'cache-invalidation'])
  })

  it('does not run deferred cache invalidation when the outer transaction rolls back', async () => {
    const invalidate = jest.fn()
    const rollbackError = new Error('deliberate upgrade rollback')
    const action: UpgradeActionDefinition = {
      id: POST_COMMIT_ACTION_ID,
      version: '99.0.0',
      messageKey: 'test.message',
      ctaKey: 'test.cta',
      successKey: 'test.success',
      async run({ deferAfterCommit }) {
        deferAfterCommit?.(invalidate)
        throw rollbackError
      },
    }
    upgradeActions.push(action)
    const transactionalEm = {
      findOne: jest.fn(async () => null),
      create: jest.fn((_Entity: unknown, input: unknown) => input),
      persist: jest.fn(),
      flush: jest.fn(async () => undefined),
    }
    const em = {
      transactional: jest.fn(async (callback: (transactionalEm: typeof transactionalEm) => Promise<unknown>) => (
        callback(transactionalEm)
      )),
    }
    const container = { resolve: jest.fn(() => em) } as never

    await expect(executeUpgradeAction(container, {
      actionId: POST_COMMIT_ACTION_ID,
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      version: '99.0.0',
    })).rejects.toBe(rollbackError)

    expect(invalidate).not.toHaveBeenCalled()
  })
})

type RunKey = { actionId: string; version: string; tenantId: string; organizationId: string }

function sameRunKey(left: RunKey, right: RunKey): boolean {
  return left.actionId === right.actionId
    && left.version === right.version
    && left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
}

function createRunStore(options: { holdLookups?: number } = {}) {
  const committed: RunKey[] = []
  const openTransactions = new Set<{ pending: RunKey[]; settled: Promise<void> }>()
  const heldLookups: Array<() => void> = []
  async function holdLookup() {
    if (!options.holdLookups) return
    await new Promise<void>((resolve) => {
      heldLookups.push(resolve)
      if (heldLookups.length === options.holdLookups) heldLookups.forEach((release) => release())
    })
  }
  function createContainer() {
    const em = {
      transactional: async (callback: (transactionalEm: unknown) => Promise<unknown>) => {
        const pending: RunKey[] = []
        const staged: RunKey[] = []
        let settle: () => void = () => undefined
        const transaction = { pending, settled: new Promise<void>((resolve) => { settle = resolve }) }
        openTransactions.add(transaction)
        const transactionalEm = {
          findOne: async (_Entity: unknown, where: RunKey) => {
            await holdLookup()
            return committed.find((row) => sameRunKey(row, where)) ?? null
          },
          create: (_Entity: unknown, input: RunKey) => input,
          persist: (row: RunKey) => {
            staged.push(row)
          },
          flush: async () => {
            for (const row of staged.splice(0)) {
              for (;;) {
                const holder = Array.from(openTransactions).find((other) => (
                  other !== transaction && other.pending.some((existing) => sameRunKey(existing, row))
                ))
                if (!holder) break
                await holder.settled
              }
              if (committed.some((existing) => sameRunKey(existing, row))) {
                throw new UniqueConstraintViolationException(new Error('duplicate key value violates unique constraint "upgrade_action_runs_action_scope_unique"'))
              }
              pending.push(row)
            }
          },
        }
        try {
          const result = await callback(transactionalEm)
          committed.push(...pending)
          return result
        } finally {
          openTransactions.delete(transaction)
          settle()
        }
      },
    }
    return { resolve: jest.fn(() => em) } as never
  }
  return { committed, createContainer }
}

describe('executeUpgradeAction concurrency', () => {
  const RACE_ACTION_ID = 'test.concurrent-non-idempotent-action'

  afterEach(() => {
    const actionIndex = upgradeActions.findIndex((action) => action.id === RACE_ACTION_ID)
    if (actionIndex >= 0) upgradeActions.splice(actionIndex, 1)
  })

  function registerAction(run: UpgradeActionDefinition['run']) {
    upgradeActions.push({
      id: RACE_ACTION_ID,
      version: '99.0.0',
      messageKey: 'test.message',
      ctaKey: 'test.cta',
      successKey: 'test.success',
      run,
    })
  }

  const input = {
    actionId: RACE_ACTION_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    version: '99.0.0',
  }

  it('runs the action body once when two requests pass the completion lookup together', async () => {
    const run = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    registerAction(run)
    const store = createRunStore({ holdLookups: 2 })

    const results = await Promise.all([
      executeUpgradeAction(store.createContainer(), input),
      executeUpgradeAction(store.createContainer(), input),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['already_completed', 'completed'])
    expect(run).toHaveBeenCalledTimes(1)
    expect(store.committed).toHaveLength(1)
  })

  it('leaves no completion record behind when the action body fails, so it can be retried', async () => {
    const failure = new Error('deliberate upgrade failure')
    const run = jest.fn(async () => undefined).mockRejectedValueOnce(failure)
    registerAction(run)
    const store = createRunStore()

    await expect(executeUpgradeAction(store.createContainer(), input)).rejects.toBe(failure)
    expect(store.committed).toHaveLength(0)

    await expect(executeUpgradeAction(store.createContainer(), input)).resolves.toMatchObject({ status: 'completed' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(store.committed).toHaveLength(1)
  })

  it('lets a waiting request run the action when the concurrent claim holder fails', async () => {
    const failure = new Error('deliberate upgrade failure')
    const run = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }).mockRejectedValueOnce(failure)
    registerAction(run)
    const store = createRunStore({ holdLookups: 2 })

    const settled = await Promise.allSettled([
      executeUpgradeAction(store.createContainer(), input),
      executeUpgradeAction(store.createContainer(), input),
    ])

    expect(settled.filter((result) => result.status === 'rejected')).toEqual([{ status: 'rejected', reason: failure }])
    expect(settled.filter((result) => result.status === 'fulfilled').map((result) => result.value.status)).toEqual(['completed'])
    expect(run).toHaveBeenCalledTimes(2)
    expect(store.committed).toHaveLength(1)
  })
})
