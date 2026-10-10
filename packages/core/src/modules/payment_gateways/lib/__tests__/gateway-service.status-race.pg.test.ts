import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy'
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql'
import { setGlobalEventBus } from '@open-mercato/shared/modules/events'
import { markQueueJobOrigin } from '@open-mercato/shared/lib/queue/dispatchOrigin'
import {
  registerGatewayAdapter,
  type GatewayAdapter,
  type UnifiedPaymentStatus,
} from '@open-mercato/shared/modules/payment_gateways/types'
import {
  GatewayPaymentOperation,
  GatewaySessionInitialization,
  GatewayTransaction,
  WebhookProcessedEvent,
} from '../../data/entities'
import { createPaymentGatewayService } from '../gateway-service'
import { processPaymentGatewayWebhookJob } from '../webhook-processor'
import handleStatusPoll from '../../workers/status-poller'

const DATABASE_URL = process.env.OM_PAYMENT_GATEWAYS_RACE_DATABASE_URL ?? ''
const ROUNDS = Number(process.env.OM_PAYMENT_GATEWAYS_RACE_ROUNDS ?? '50')
const PARALLEL = Number(process.env.OM_PAYMENT_GATEWAYS_RACE_PARALLEL ?? '10')
const POOL_MAX = Number(process.env.OM_PAYMENT_GATEWAYS_RACE_POOL_MAX ?? '10')
const PROVIDER_KEY = 'race-provider'
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa'

const describeWithDatabase = DATABASE_URL ? describe : describe.skip

type ProviderSession = {
  pollStatus: UnifiedPaymentStatus
  pollGate: Promise<void> | null
  onPollStarted: (() => void) | null
  maxDelayMs: number
  captureAmount: number | null
}

type EmittedEvent = { id: string; transactionId: string }

const sessions = new Map<string, ProviderSession>()
const emitted: EmittedEvent[] = []

function delay(maxMs: number): Promise<void> {
  if (maxMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * maxMs)))
}

function readSession(sessionId: string): ProviderSession {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`[internal] unknown race session ${sessionId}`)
  return session
}

const raceAdapter: GatewayAdapter = {
  providerKey: PROVIDER_KEY,
  async createSession() {
    throw new Error('[internal] not used')
  },
  async capture(input) {
    const session = readSession(input.sessionId)
    await delay(session.maxDelayMs)
    return {
      status: 'captured',
      capturedAmount: session.captureAmount ?? input.amount,
      providerData: { captureMarker: input.sessionId },
    }
  },
  async refund(input) {
    await delay(readSession(input.sessionId).maxDelayMs)
    return { status: 'refunded', refundId: `re_${input.sessionId}`, refundedAmount: input.amount ?? 0 }
  },
  async cancel(input) {
    await delay(readSession(input.sessionId).maxDelayMs)
    return { status: 'cancelled' }
  },
  async getStatus(input) {
    const session = readSession(input.sessionId)
    session.onPollStarted?.()
    if (session.pollGate) await session.pollGate
    await delay(session.maxDelayMs)
    return {
      status: session.pollStatus,
      amount: 100,
      amountReceived: 0,
      currencyCode: 'USD',
      providerData: { pollMarker: true },
    }
  },
  async verifyWebhook() {
    throw new Error('[internal] not used')
  },
  mapStatus(providerStatus) {
    return providerStatus as UnifiedPaymentStatus
  },
}

const integrationCredentialsService = { resolve: async () => ({}) }
const integrationLogService = {
  write: async () => undefined,
  scoped: () => ({ info: async () => undefined, warn: async () => undefined, error: async () => undefined }),
}

let orm: MikroORM

function buildService(em: EntityManager) {
  return createPaymentGatewayService({
    em,
    integrationCredentialsService: integrationCredentialsService as never,
    integrationLogService: integrationLogService as never,
  })
}

async function runPoller(organizationId: string): Promise<void> {
  const em = orm.em.fork() as unknown as EntityManager
  const service = buildService(em)
  await handleStatusPoll(
    { id: randomUUID(), payload: { scope: { organizationId, tenantId: TENANT_ID, providerKey: PROVIDER_KEY } } } as never,
    {
      resolve: <T,>(name: string): T => {
        if (name === 'paymentGatewayService') return service as T
        if (name === 'integrationLogService') return integrationLogService as T
        throw new Error(`[internal] unexpected resolve ${name}`)
      },
    } as never,
  )
}

async function deliverWebhook(
  transaction: { id: string; organizationId: string },
  status: UnifiedPaymentStatus,
  marker: string,
): Promise<void> {
  const em = orm.em.fork() as unknown as EntityManager
  const service = buildService(em)
  await processPaymentGatewayWebhookJob(
    { em, paymentGatewayService: service, integrationLogService: integrationLogService as never },
    markQueueJobOrigin({
      providerKey: PROVIDER_KEY,
      transactionId: transaction.id,
      scope: { organizationId: transaction.organizationId, tenantId: TENANT_ID },
      event: {
        eventType: `race.${status}`,
        eventId: randomUUID(),
        idempotencyKey: randomUUID(),
        timestamp: new Date(),
        data: { status, [marker]: true },
      },
    }, 'inbound-webhook'),
  )
}

async function manualCapture(transaction: { id: string; organizationId: string }): Promise<void> {
  const service = buildService(orm.em.fork() as unknown as EntityManager)
  await service.capturePayment(transaction.id, undefined, { organizationId: transaction.organizationId, tenantId: TENANT_ID })
}

async function manualCancel(transaction: { id: string; organizationId: string }): Promise<void> {
  const service = buildService(orm.em.fork() as unknown as EntityManager)
  await service.cancelPayment(transaction.id, undefined, { organizationId: transaction.organizationId, tenantId: TENANT_ID })
}

async function seedTransaction(status: UnifiedPaymentStatus, session: Partial<ProviderSession>) {
  const em = orm.em.fork()
  const organizationId = randomUUID()
  const providerSessionId = `sess_${randomUUID()}`
  sessions.set(providerSessionId, {
    pollStatus: 'captured',
    pollGate: null,
    onPollStarted: null,
    maxDelayMs: 0,
    captureAmount: null,
    ...session,
  })
  const transaction = em.create(GatewayTransaction, {
    paymentId: randomUUID(),
    providerKey: PROVIDER_KEY,
    providerSessionId,
    unifiedStatus: status,
    amount: '100',
    capturedAmount: status === 'captured' ? '100' : '0',
    currencyCode: 'USD',
    gatewayMetadata: {},
    organizationId,
    tenantId: TENANT_ID,
    deletedAt: null,
  })
  await em.persist(transaction).flush()
  return { id: transaction.id, organizationId, providerSessionId }
}

async function readTransaction(id: string): Promise<GatewayTransaction> {
  const em = orm.em.fork()
  const row = await em.findOneOrFail(GatewayTransaction, { id })
  return row
}

function eventsFor(transactionId: string): string[] {
  return emitted.filter((event) => event.transactionId === transactionId).map((event) => event.id.replace('payment_gateways.payment.', ''))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describeWithDatabase('payment gateway status poll vs concurrent writers (real Postgres)', () => {
  beforeAll(async () => {
    orm = await MikroORM.init({
      clientUrl: DATABASE_URL,
      entities: [GatewayTransaction, GatewayPaymentOperation, GatewaySessionInitialization, WebhookProcessedEvent],
      metadataProvider: ReflectMetadataProvider,
      allowGlobalContext: true,
      debug: false,
      pool: { min: 0, max: POOL_MAX },
    })
    await orm.schema.refresh()
    registerGatewayAdapter(raceAdapter)
    setGlobalEventBus({
      emit: async (id: string, payload: unknown) => {
        const transactionId = (payload as { transactionId?: string } | null)?.transactionId
        if (transactionId) emitted.push({ id, transactionId })
      },
    })
  }, 60_000)

  afterAll(async () => {
    await orm?.close(true)
  })

  describe('deterministic interleavings', () => {
    it('poll that read authorized does not overwrite a partial refund committed by webhooks', async () => {
      const gate = deferred()
      const started = deferred()
      const txn = await seedTransaction('authorized', { pollStatus: 'captured', pollGate: gate.promise, onPollStarted: started.resolve })
      const poll = runPoller(txn.organizationId)
      await started.promise
      await deliverWebhook(txn, 'captured', 'captureWebhookMarker')
      await deliverWebhook(txn, 'partially_refunded', 'refundWebhookMarker')
      gate.resolve()
      await poll
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('partially_refunded')
      expect(row.gatewayMetadata).toEqual(expect.objectContaining({ refundWebhookMarker: true }))
      expect(eventsFor(txn.id)).toEqual(['captured'])
    })

    it('poll that read authorized does not overwrite a full refund committed by webhooks', async () => {
      const gate = deferred()
      const started = deferred()
      const txn = await seedTransaction('authorized', { pollStatus: 'captured', pollGate: gate.promise, onPollStarted: started.resolve })
      const poll = runPoller(txn.organizationId)
      await started.promise
      await deliverWebhook(txn, 'captured', 'captureWebhookMarker')
      await deliverWebhook(txn, 'refunded', 'refundWebhookMarker')
      gate.resolve()
      await poll
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('refunded')
      expect(eventsFor(txn.id)).toEqual(['captured', 'refunded'])
    })

    it('poll and a manual capture of the same authorization emit captured once', async () => {
      const gate = deferred()
      const started = deferred()
      const txn = await seedTransaction('authorized', { pollStatus: 'captured', pollGate: gate.promise, onPollStarted: started.resolve })
      const poll = runPoller(txn.organizationId)
      await started.promise
      await manualCapture(txn)
      gate.resolve()
      await poll
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('captured')
      expect(row.capturedAmount).toBe('100.0000')
      expect(eventsFor(txn.id)).toEqual(['captured'])
    })

    it('two polls of the same authorization emit captured once', async () => {
      const gate = deferred()
      let startedCount = 0
      const bothStarted = deferred()
      const txn = await seedTransaction('authorized', {
        pollStatus: 'captured',
        pollGate: gate.promise,
        onPollStarted: () => {
          startedCount += 1
          if (startedCount === 2) bothStarted.resolve()
        },
      })
      const polls = Promise.all([runPoller(txn.organizationId), runPoller(txn.organizationId)])
      await bothStarted.promise
      gate.resolve()
      await polls
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('captured')
      expect(eventsFor(txn.id)).toEqual(['captured'])
    })

    it('poll that read authorized does not re-announce a cancellation already committed', async () => {
      const gate = deferred()
      const started = deferred()
      const txn = await seedTransaction('authorized', { pollStatus: 'cancelled', pollGate: gate.promise, onPollStarted: started.resolve })
      const poll = runPoller(txn.organizationId)
      await started.promise
      await manualCancel(txn)
      gate.resolve()
      await poll
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('cancelled')
      expect(eventsFor(txn.id)).toEqual(['cancelled'])
    })

    it('manual capture settles the ledger to what the provider actually captured', async () => {
      const txn = await seedTransaction('authorized', { captureAmount: 90 })
      await manualCapture(txn)
      const row = await readTransaction(txn.id)
      expect(row.unifiedStatus).toBe('captured')
      expect(row.capturedAmount).toBe('90.0000')
      expect(eventsFor(txn.id)).toEqual(['captured'])
    })
  })

  describe('jittered races', () => {
    type Category = {
      name: string
      initial: UnifiedPaymentStatus
      pollStatus: UnifiedPaymentStatus
      writers: (txn: { id: string; organizationId: string }) => Array<() => Promise<void>>
      expectedStatus: UnifiedPaymentStatus
      expectedEvents: string[]
      requiredMetadata?: string
    }

    const sequential = (...steps: Array<() => Promise<void>>) => async () => {
      for (const step of steps) {
        await delay(5)
        await step()
      }
    }

    const categories: Category[] = [
      {
        name: 'poll vs partial refund',
        initial: 'authorized',
        pollStatus: 'captured',
        writers: (txn) => [sequential(
          () => deliverWebhook(txn, 'captured', 'captureWebhookMarker'),
          () => deliverWebhook(txn, 'partially_refunded', 'refundWebhookMarker'),
        )],
        expectedStatus: 'partially_refunded',
        expectedEvents: ['captured'],
        requiredMetadata: 'refundWebhookMarker',
      },
      {
        name: 'poll vs full refund',
        initial: 'authorized',
        pollStatus: 'captured',
        writers: (txn) => [sequential(
          () => deliverWebhook(txn, 'captured', 'captureWebhookMarker'),
          () => deliverWebhook(txn, 'refunded', 'refundWebhookMarker'),
        )],
        expectedStatus: 'refunded',
        expectedEvents: ['captured', 'refunded'],
        requiredMetadata: 'refundWebhookMarker',
      },
      {
        name: 'poll vs capture',
        initial: 'authorized',
        pollStatus: 'captured',
        writers: (txn) => [() => manualCapture(txn)],
        expectedStatus: 'captured',
        expectedEvents: ['captured'],
      },
      {
        name: 'poll vs poll',
        initial: 'authorized',
        pollStatus: 'captured',
        writers: (txn) => [() => runPoller(txn.organizationId)],
        expectedStatus: 'captured',
        expectedEvents: ['captured'],
      },
      {
        name: 'poll vs cancel',
        initial: 'authorized',
        pollStatus: 'cancelled',
        writers: (txn) => [() => manualCancel(txn)],
        expectedStatus: 'cancelled',
        expectedEvents: ['cancelled'],
      },
    ]

    type RoundOutcome = { problems: string[]; kinds: string[] }

    async function runRound(category: Category): Promise<RoundOutcome> {
      const txn = await seedTransaction(category.initial, { pollStatus: category.pollStatus, maxDelayMs: 12 })
      const actors = [() => runPoller(txn.organizationId), ...category.writers(txn)]
      const results = await Promise.allSettled(actors.map(async (actor) => {
        await delay(10)
        await actor()
      }))
      const row = await readTransaction(txn.id)
      const events = eventsFor(txn.id)
      const problems: string[] = []
      const kinds: string[] = []
      for (const result of results) {
        if (result.status === 'rejected') {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
          if (!/Cannot (capture|cancel) a payment in status|not a valid transition|already fully captured|changed while the capture amount/.test(message)) {
            problems.push(`error: ${message}`)
            kinds.push('unexpected error')
          }
        }
      }
      if (row.unifiedStatus !== category.expectedStatus) {
        problems.push(`status ${row.unifiedStatus}`)
        kinds.push('status lost update')
      }
      if (JSON.stringify(events) !== JSON.stringify(category.expectedEvents)) {
        problems.push(`events ${events.join(',')}`)
        kinds.push('duplicate or stale event')
      }
      if (category.requiredMetadata && row.gatewayMetadata?.[category.requiredMetadata] !== true) {
        problems.push(`metadata lost ${category.requiredMetadata}`)
        kinds.push('metadata lost update')
      }
      if (['captured', 'refunded', 'partially_refunded'].includes(row.unifiedStatus) && row.capturedAmount !== '100.0000') {
        problems.push(`capturedAmount ${row.capturedAmount}`)
        kinds.push('captured amount drift')
      }
      return { problems, kinds }
    }

    type Summary = { category: string; rounds: number; violations: number; kinds: Record<string, number>; examples: string[] }
    const summary: Summary[] = []

    function record(name: string, outcomes: RoundOutcome[]): string[] {
      const violations: string[] = []
      const kinds: Record<string, number> = {}
      outcomes.forEach((outcome, round) => {
        if (outcome.problems.length === 0) return
        violations.push(`round ${round}: ${outcome.problems.join('; ')}`)
        for (const kind of new Set(outcome.kinds)) kinds[kind] = (kinds[kind] ?? 0) + 1
      })
      summary.push({ category: name, rounds: outcomes.length, violations: violations.length, kinds, examples: violations.slice(0, 3) })
      return violations
    }

    afterAll(() => {
      process.stdout.write(`RACE_SUMMARY ${JSON.stringify(summary)}\n`)
    })

    for (const category of categories) {
      it(`${category.name}: ${ROUNDS} rounds without a lost update or duplicate event`, async () => {
        const outcomes: RoundOutcome[] = []
        for (let round = 0; round < ROUNDS; round += 1) outcomes.push(await runRound(category))
        expect(record(category.name, outcomes)).toEqual([])
      }, 600_000)
    }

    it(`all categories on distinct transactions, ${PARALLEL} rounds at a time (pool ${POOL_MAX})`, async () => {
      const outcomes: RoundOutcome[] = []
      const total = ROUNDS
      for (let offset = 0; offset < total; offset += PARALLEL) {
        const batch = Array.from({ length: Math.min(PARALLEL, total - offset) }, (_, index) => categories[(offset + index) % categories.length])
        outcomes.push(...await Promise.all(batch.map((category) => runRound(category))))
      }
      expect(record('parallel distinct transactions', outcomes)).toEqual([])
    }, 600_000)
  })
})
