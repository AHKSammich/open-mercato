import path from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { deletePhoneCallsIfExist } from './helpers/phoneCallsFixtures'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT.trim())
  : path.resolve(process.cwd(), 'apps/mercato')

const INGEST_COMMAND_ID = 'phone_calls.call.ingest'
const CONCURRENCY = 6

type IngestResult = { phoneCallId: string; created: boolean }
type TokenScope = ReturnType<typeof getTokenScope>
type Participant = { role: string; displayName: string }

function ingest(
  commandBus: CommandBus,
  container: AwilixContainer,
  scope: TokenScope,
  externalCallId: string,
  participants: Participant[],
) {
  return commandBus.execute<Record<string, unknown>, IngestResult>(INGEST_COMMAND_ID, {
    input: {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      providerKey: 'tillio',
      externalCallId,
      direction: 'inbound',
      status: 'completed',
      participants,
      startedAt: new Date('2026-03-10T09:00:00Z'),
      rawPayload: { source: 'TC-PHONE-HUB-007' },
    },
    ctx: {
      container,
      auth: {
        sub: scope.userId,
        tenantId: scope.tenantId,
        orgId: scope.organizationId,
        isSuperAdmin: false,
      },
      organizationScope: {
        selectedId: scope.organizationId,
        filterIds: [scope.organizationId],
        allowedIds: [scope.organizationId],
        tenantId: scope.tenantId,
      },
      selectedOrganizationId: scope.organizationId,
      organizationIds: [scope.organizationId],
    },
  })
}

async function readStoredCall(
  container: AwilixContainer,
  scope: TokenScope,
  externalCallId: string,
): Promise<{ callIds: string[]; participantCount: number }> {
  const connection = (container.resolve('em') as EntityManager).fork().getConnection()
  const calls = await connection.execute<Array<{ id: string }>>(
    'select id from phone_calls where tenant_id = ? and organization_id = ? and provider_key = ? and external_call_id = ?',
    [scope.tenantId, scope.organizationId, 'tillio', externalCallId],
  )
  const callIds = calls.map((row) => row.id)
  if (!callIds.length) return { callIds, participantCount: 0 }
  const counted = await connection.execute<Array<{ total: string | number }>>(
    'select count(*) as total from phone_call_participants where phone_call_id = ?',
    [callIds[0]],
  )
  return { callIds, participantCount: Number(counted[0]?.total ?? 0) }
}

function rejectionMessages(outcomes: Array<PromiseSettledResult<unknown>>): string[] {
  return outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map((outcome) => String((outcome.reason as Error)?.message ?? outcome.reason))
}

function fulfilledResults(outcomes: Array<PromiseSettledResult<{ result: IngestResult }>>): IngestResult[] {
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<{ result: IngestResult }>).value.result)
}

/**
 * TC-PHONE-HUB-007 — concurrent ingests of one external call resolve as one create plus updates.
 *
 * The ingest command is the hub's idempotency contract: a provider may deliver the same call
 * more than once, and overlapping pulls or a replayed job can deliver it at the same moment.
 * Every delivery must land on the single row the unique index allows, and a concurrent
 * re-ingest must replace the participant set rather than append a second copy of it.
 *
 * Driven through the command bus in this process for the same reason as TC-PHONE-HUB-006: the
 * hub has no route that writes. The calls land in a run-unique organization id: an ingest writes
 * search tokens, and tokens present for the admin organization would move TC-PHONE-HUB-006's
 * `q` search off the plain-column path it relies on.
 */
test.describe('TC-PHONE-HUB-007: concurrent ingest of the same call is idempotent', () => {
  const participants: Participant[] = [
    { role: 'caller', displayName: 'Caller' },
    { role: 'callee', displayName: 'Callee' },
  ]

  async function setup(request: APIRequestContext) {
    const token = await getAuthToken(request)
    const scope: TokenScope = { ...getTokenScope(token), organizationId: randomUUID() }
    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const commandBus = container.resolve('commandBus') as CommandBus
    return { scope, container, commandBus }
  }

  async function cleanup(container: AwilixContainer, scope: TokenScope, externalCallIds: string[]) {
    const ids: string[] = []
    for (const externalCallId of externalCallIds) {
      const stored = await readStoredCall(container, scope, externalCallId).catch(() => null)
      ids.push(...(stored?.callIds ?? []))
    }
    await deletePhoneCallsIfExist(ids)
  }

  test('parallel first deliveries of one call create one row with one participant set', async ({ request }) => {
    test.slow()
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`
    const warmupCallId = `qa-phone-hub-007-warmup-${stamp}`
    const externalCallId = `qa-phone-hub-007-new-${stamp}`
    const distinctCallIds = Array.from({ length: 3 }, (_, index) => `qa-phone-hub-007-distinct-${index}-${stamp}`)
    const { scope, container, commandBus } = await setup(request)

    try {
      await ingest(commandBus, container, scope, warmupCallId, [])

      const outcomes = await Promise.allSettled([
        ...Array.from({ length: CONCURRENCY }, () => ingest(commandBus, container, scope, externalCallId, participants)),
        ...distinctCallIds.map((distinctCallId) => ingest(commandBus, container, scope, distinctCallId, participants)),
      ])
      expect(rejectionMessages(outcomes), 'no delivery may fail on the unique index').toEqual([])

      const results = fulfilledResults(outcomes)
      const sameCall = results.slice(0, CONCURRENCY)
      expect(sameCall.filter((result) => result.created), 'exactly one delivery inserts').toHaveLength(1)
      expect(new Set(sameCall.map((result) => result.phoneCallId)).size, 'every delivery resolves to one row').toBe(1)
      expect(results.slice(CONCURRENCY).every((result) => result.created), 'distinct calls do not wait on each other').toBe(true)

      const stored = await readStoredCall(container, scope, externalCallId)
      expect(stored.callIds).toEqual([sameCall[0].phoneCallId])
      expect(stored.participantCount, 'the participant set is stored once').toBe(participants.length)
    } finally {
      await cleanup(container, scope, [warmupCallId, externalCallId, ...distinctCallIds])
    }
  })

  test('parallel re-deliveries of an ingested call keep one participant set', async ({ request }) => {
    test.slow()
    const stamp = `${Date.now()}-${randomInt(1_000_000)}`
    const externalCallId = `qa-phone-hub-007-again-${stamp}`
    const { scope, container, commandBus } = await setup(request)

    try {
      const first = await ingest(commandBus, container, scope, externalCallId, participants)
      expect(first.result.created).toBe(true)

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => ingest(commandBus, container, scope, externalCallId, participants)),
      )
      expect(rejectionMessages(outcomes)).toEqual([])
      const results = fulfilledResults(outcomes)
      expect(results.every((result) => !result.created && result.phoneCallId === first.result.phoneCallId)).toBe(true)

      const stored = await readStoredCall(container, scope, externalCallId)
      expect(stored.callIds).toEqual([first.result.phoneCallId])
      expect(stored.participantCount, 'a concurrent re-ingest replaces the set instead of appending to it').toBe(participants.length)
    } finally {
      await cleanup(container, scope, [externalCallId])
    }
  })
})
