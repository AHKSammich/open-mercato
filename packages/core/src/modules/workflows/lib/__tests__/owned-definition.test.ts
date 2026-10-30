import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { WorkflowDefinition } from '../../data/entities'
import { syncWorkflowDefinitionPrincipal } from '../definition-grant'
import { invalidateTriggerCache } from '../event-trigger-service'
import { createWorkflowDefinitionAuthoring, type OwnedWorkflowDefinitionInput } from '../owned-definition'

jest.mock('../definition-grant', () => ({
  ...jest.requireActual('../definition-grant'),
  syncWorkflowDefinitionPrincipal: jest.fn(async () => undefined),
}))

jest.mock('../event-trigger-service', () => ({
  invalidateTriggerCache: jest.fn(),
}))

const syncPrincipal = syncWorkflowDefinitionPrincipal as jest.MockedFunction<typeof syncWorkflowDefinitionPrincipal>
const invalidateCache = invalidateTriggerCache as jest.MockedFunction<typeof invalidateTriggerCache>

const VERSION_UNIQUE = 'workflow_definitions_workflow_id_version_tenant_id_unique'

function uniqueViolation(constraint: string = VERSION_UNIQUE): UniqueConstraintViolationException {
  return new UniqueConstraintViolationException(
    Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
      code: '23505',
      constraint,
    }),
  )
}

function makeInput(overrides: Partial<OwnedWorkflowDefinitionInput> = {}): OwnedWorkflowDefinitionInput {
  return {
    ownerModule: 'agent_orchestrator',
    ownerId: 'process-1',
    workflowId: 'process_1',
    workflowName: 'Loser name',
    definition: { steps: [], transitions: [] } as never,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    ...overrides,
  }
}

function makeWinner(owner: { module: string; ownerId: string }): WorkflowDefinition {
  return {
    id: 'winner-id',
    workflowId: 'process_1',
    workflowName: 'Winner name',
    version: 1,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    metadata: { generatedBy: owner },
    grantedFeatures: null,
  } as unknown as WorkflowDefinition
}

type FakeEm = {
  findOne: jest.Mock
  create: jest.Mock
  persist: jest.Mock
  flush: jest.Mock
  isInTransaction: jest.Mock
  getUnitOfWork: jest.Mock
  unsetIdentity: jest.Mock
  created: Array<Record<string, unknown>>
}

function makeEm(options: { reads: Array<WorkflowDefinition | null>; flushes: Array<Error | null>; inTransaction?: boolean }): FakeEm {
  const created: Array<Record<string, unknown>> = []
  const unsetIdentity = jest.fn()
  const findOne = jest.fn()
  for (const read of options.reads) findOne.mockResolvedValueOnce(read)
  const flush = jest.fn()
  for (const outcome of options.flushes) {
    if (outcome) flush.mockRejectedValueOnce(outcome)
    else flush.mockResolvedValueOnce(undefined)
  }
  return {
    findOne,
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const row = { ...data }
      created.push(row)
      return row
    }),
    persist: jest.fn(),
    flush,
    isInTransaction: jest.fn(() => options.inTransaction ?? false),
    getUnitOfWork: jest.fn(() => ({ unsetIdentity })),
    unsetIdentity,
    created,
  }
}

function upsert(em: FakeEm, input: OwnedWorkflowDefinitionInput) {
  const authoring = createWorkflowDefinitionAuthoring({} as AwilixContainer)
  return authoring.upsertOwnedDefinition(em as unknown as EntityManager, input)
}

describe('upsertOwnedDefinition — losing a concurrent first create', () => {
  beforeEach(() => {
    syncPrincipal.mockClear()
    invalidateCache.mockClear()
  })

  it('updates the row a concurrent caller with the same owner just created instead of throwing', async () => {
    const winner = makeWinner({ module: 'agent_orchestrator', ownerId: 'process-1' })
    const em = makeEm({ reads: [null, winner, winner], flushes: [uniqueViolation(), null] })

    const result = await upsert(em, makeInput({ grantedFeatures: ['workflows.instances.view'] }))

    expect(result).toEqual({ ok: true, created: false, definition: winner })
    expect(winner.workflowName).toBe('Loser name')
    expect(winner.grantedFeatures).toEqual(['workflows.instances.view'])
    expect(em.created).toHaveLength(1)
    expect(em.unsetIdentity).toHaveBeenCalledWith(em.created[0])
    expect(em.flush).toHaveBeenCalledTimes(2)
    expect(invalidateCache).toHaveBeenCalledTimes(1)
  })

  it('re-scopes the losing row principal to no features', async () => {
    const winner = makeWinner({ module: 'agent_orchestrator', ownerId: 'process-1' })
    const em = makeEm({ reads: [null, winner, winner], flushes: [uniqueViolation(), null] })

    await upsert(em, makeInput({ grantedFeatures: ['workflows.instances.view'] }))

    const loserId = em.created[0].id
    expect(syncPrincipal).toHaveBeenCalledTimes(3)
    expect(syncPrincipal.mock.calls[1][1]).toEqual(
      expect.objectContaining({ id: loserId, grantedFeatures: null }),
    )
    expect(syncPrincipal.mock.calls[1][2]).toEqual({ previousFeatures: ['workflows.instances.view'] })
    expect(syncPrincipal.mock.calls[2][1]).toBe(winner)
  })

  it('returns owned_by_other when a different owner won the race', async () => {
    const winner = makeWinner({ module: 'agent_orchestrator', ownerId: 'process-2' })
    const em = makeEm({ reads: [null, winner, winner], flushes: [uniqueViolation()] })

    const result = await upsert(em, makeInput())

    expect(result).toEqual({ ok: false, reason: 'owned_by_other', definition: winner })
    expect(winner.workflowName).toBe('Winner name')
    expect(em.flush).toHaveBeenCalledTimes(1)
    expect(em.unsetIdentity).toHaveBeenCalledWith(em.created[0])
  })

  it('still throws a flush failure that is not a unique violation', async () => {
    const failure = new Error('connection terminated')
    const em = makeEm({ reads: [null], flushes: [failure] })

    await expect(upsert(em, makeInput())).rejects.toBe(failure)
    expect(em.findOne).toHaveBeenCalledTimes(1)
    expect(em.unsetIdentity).not.toHaveBeenCalled()
  })

  it('still throws a unique violation on a different constraint', async () => {
    const failure = uniqueViolation('some_other_unique')
    const em = makeEm({ reads: [null], flushes: [failure] })

    await expect(upsert(em, makeInput())).rejects.toBe(failure)
    expect(em.findOne).toHaveBeenCalledTimes(1)
  })

  it('still throws inside an outer transaction, after detaching the failed row and re-scoping its principal', async () => {
    const failure = uniqueViolation()
    const em = makeEm({ reads: [null], flushes: [failure], inTransaction: true })

    await expect(upsert(em, makeInput({ grantedFeatures: ['workflows.instances.view'] }))).rejects.toBe(failure)
    expect(em.unsetIdentity).toHaveBeenCalledWith(em.created[0])
    expect(em.findOne).toHaveBeenCalledTimes(1)
    expect(syncPrincipal).toHaveBeenCalledTimes(2)
    expect(syncPrincipal.mock.calls[1][1]).toEqual(
      expect.objectContaining({ id: em.created[0].id, grantedFeatures: null }),
    )
  })

  it('still throws when no live row is found after the violation', async () => {
    const failure = uniqueViolation()
    const em = makeEm({ reads: [null, null], flushes: [failure] })

    await expect(upsert(em, makeInput())).rejects.toBe(failure)
    expect(em.findOne).toHaveBeenCalledTimes(2)
    expect(em.flush).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failing update of an existing row', async () => {
    const existing = makeWinner({ module: 'agent_orchestrator', ownerId: 'process-1' })
    const failure = uniqueViolation()
    const em = makeEm({ reads: [existing], flushes: [failure] })

    await expect(upsert(em, makeInput())).rejects.toBe(failure)
    expect(em.findOne).toHaveBeenCalledTimes(1)
    expect(em.unsetIdentity).not.toHaveBeenCalled()
  })
})
