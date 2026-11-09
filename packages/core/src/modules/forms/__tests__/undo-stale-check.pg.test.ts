/**
 * Forms undo vs a concurrent write against a real PostgreSQL.
 *
 * `forms.invitation.send` undo restores the pre-send status. The public runtime
 * can open the invitation at any moment. Whether the open commits before the
 * undo reads the row or while the undo is between its read and its write, the
 * open must survive: the invitation ends `opened`, never back on `pending`.
 * The same holds for a distribution reopened while a close is being undone.
 *
 * Gated on OM_FORMS_PG_URL — a throwaway database, since the suite drops and
 * recreates the forms tables it uses. Never point it at a development or
 * shared database. Run it with, for example:
 *
 *   docker run -d --rm --name om-forms-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=om \
 *     -p 54373:5432 postgres:18-alpine
 *   OM_FORMS_PG_URL=postgres://postgres:postgres@127.0.0.1:54373/om \
 *     yarn workspace @open-mercato/core jest undo-stale-check.pg
 */
import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy'
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql'
import { FormDistribution, FormInvitation } from '../data/entities'
import { sendInvitationCommand } from '../commands/invitation'
import { closeDistributionCommand } from '../commands/distribution'

const PG_URL = process.env.OM_FORMS_PG_URL ?? ''
const ROUNDS = Number(process.env.OM_FORMS_RACE_ROUNDS ?? '50')
const PARALLEL = Number(process.env.OM_FORMS_RACE_PARALLEL ?? '8')
const maybe = PG_URL ? describe : describe.skip

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const SENT_AT = new Date('2026-01-01T00:05:00.000Z')

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function ignoreUndoConflict(error: unknown): void {
  if ((error as { status?: number } | null)?.status !== 409) throw error
}

async function waitForLockWaiters(count: () => Promise<number>, expected: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let current = await count()
  while (current !== expected && Date.now() < deadline) {
    await delay(50)
    current = await count()
  }
  return current
}

function withGatedFlush(em: EntityManager, beforeFlush: () => Promise<void>): EntityManager {
  return new Proxy(em, {
    get(target, property, receiver) {
      if (property === 'flush') {
        return async () => {
          await beforeFlush()
          return target.flush()
        }
      }
      if (property === 'fork') {
        return (options?: unknown) => withGatedFlush(target.fork(options as never) as EntityManager, beforeFlush)
      }
      if (property === 'transactional') {
        return (callback: (trx: EntityManager) => Promise<unknown>, options?: unknown) =>
          target.transactional((trx) => callback(withGatedFlush(trx as EntityManager, beforeFlush)), options as never)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

maybe('forms undo vs a concurrent write against PostgreSQL', () => {
  jest.setTimeout(300_000)
  let orm: MikroORM

  beforeAll(async () => {
    orm = await MikroORM.init({
      clientUrl: PG_URL,
      entities: [FormInvitation, FormDistribution],
      metadataProvider: ReflectMetadataProvider,
      allowGlobalContext: true,
      debug: false,
      pool: { min: 0, max: PARALLEL * 3 + 4 },
    })
    await orm.schema.refresh()
  }, 60_000)

  afterAll(async () => {
    await orm?.close(true)
  })

  function contextFor(emFactory: () => EntityManager) {
    return {
      container: {
        resolve: () => emFactory(),
        hasRegistration: () => false,
      },
      auth: { sub: randomUUID(), tenantId: TENANT_ID, orgId: ORG_ID, isSuperAdmin: false },
      organizationScope: null,
      selectedOrganizationId: ORG_ID,
    }
  }

  async function seedSentInvitation(): Promise<string> {
    const em = orm.em.fork()
    const now = new Date()
    const invitation = em.create(FormInvitation, {
      distributionId: randomUUID(),
      organizationId: ORG_ID,
      tenantId: TENANT_ID,
      recipientEmail: null,
      recipientName: null,
      recipientRef: null,
      role: null,
      tokenHash: null,
      status: 'sent',
      submissionId: null,
      locale: null,
      sentAt: SENT_AT,
      sendCount: 1,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(invitation)
    await em.flush()
    return invitation.id
  }

  function sendUndoLogEntry(invitationId: string) {
    const snapshot = { id: invitationId, organizationId: ORG_ID, tenantId: TENANT_ID }
    return {
      commandPayload: {
        undo: {
          before: { ...snapshot, status: 'pending', sentAt: null, sendCount: 0 },
          after: { ...snapshot, status: 'sent', sentAt: SENT_AT.toISOString(), sendCount: 1 },
          staleCheck: true,
        },
      },
    }
  }

  function undoSend(invitationId: string, emFactory: () => EntityManager = () => orm.em.fork()) {
    return sendInvitationCommand.undo!({
      logEntry: sendUndoLogEntry(invitationId),
      ctx: contextFor(emFactory),
    } as never)
  }

  async function openInvitation(invitationId: string): Promise<void> {
    await orm.em.fork().nativeUpdate(FormInvitation, { id: invitationId }, { status: 'opened', openedAt: new Date() })
  }

  async function readInvitationStatus(invitationId: string): Promise<string> {
    const row = await orm.em.fork().findOneOrFail(FormInvitation, { id: invitationId })
    return row.status
  }

  async function lockWaitingUpdates(table: string): Promise<number> {
    const rows = await orm.em.getConnection().execute<Array<{ count: string }>>(
      `select count(*)::text as count from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike ?`,
      [`update "${table}"%`],
    )
    return Number(rows[0]?.count ?? 0)
  }

  it('refuses a send undo after the invitation was opened and keeps it opened', async () => {
    const invitationId = await seedSentInvitation()
    await openInvitation(invitationId)

    await expect(undoSend(invitationId)).rejects.toMatchObject({
      status: 409,
      body: { code: 'forms.errors.undo_conflict' },
    })
    expect(await readInvitationStatus(invitationId)).toBe('opened')
  })

  it('an open that arrives while the undo is between its read and its write waits and survives', async () => {
    const invitationId = await seedSentInvitation()
    const writeReached = deferred()
    const releaseWrite = deferred()
    const undoing = undoSend(invitationId, () =>
      withGatedFlush(orm.em.fork(), async () => {
        writeReached.resolve()
        await releaseWrite.promise
      }),
    )
    await writeReached.promise
    let openSettled = false
    const opening = openInvitation(invitationId).finally(() => {
      openSettled = true
    })
    const waitingOnLock = await waitForLockWaiters(() => lockWaitingUpdates('forms_invitation'), 1, 3_000)
    const openFinishedBeforeUndoWrite = openSettled
    releaseWrite.resolve()
    await expect(undoing).resolves.toBeUndefined()
    await opening

    const final = await readInvitationStatus(invitationId)
    console.info(
      `[forms undo race] interleaved: openFinishedBeforeUndoWrite=${openFinishedBeforeUndoWrite} waitingOnLock=${waitingOnLock} final=${final}`,
    )
    expect(openFinishedBeforeUndoWrite).toBe(false)
    expect(waitingOnLock).toBe(1)
    expect(final).toBe('opened')
  })

  it('a reopen that arrives while a close undo is between its read and its write waits and survives', async () => {
    const em = orm.em.fork()
    const now = new Date()
    const distribution = em.create(FormDistribution, {
      organizationId: ORG_ID,
      tenantId: TENANT_ID,
      formId: randomUUID(),
      pinnedVersionId: null,
      mode: 'open',
      publicSlug: `slug-${randomUUID()}`,
      status: 'closed',
      title: null,
      defaultLocale: 'en',
      requireCustomerAuth: false,
      allowMultipleSubmissions: false,
      maxResponses: null,
      responseCount: 0,
      opensAt: null,
      closesAt: null,
      redirectUrl: null,
      settings: null,
      createdBy: randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    em.persist(distribution)
    await em.flush()
    const snapshot = { id: distribution.id, organizationId: ORG_ID, tenantId: TENANT_ID }
    const writeReached = deferred()
    const releaseWrite = deferred()
    const undoing = closeDistributionCommand.undo!({
      logEntry: {
        commandPayload: {
          undo: { before: { ...snapshot, status: 'paused' }, after: { ...snapshot, status: 'closed' }, staleCheck: true },
        },
      },
      ctx: contextFor(() =>
        withGatedFlush(orm.em.fork(), async () => {
          writeReached.resolve()
          await releaseWrite.promise
        }),
      ),
    } as never)
    await writeReached.promise
    const reopening = orm.em.fork().nativeUpdate(FormDistribution, { id: distribution.id }, { status: 'active' })
    const waitingOnLock = await waitForLockWaiters(() => lockWaitingUpdates('forms_distribution'), 1)
    releaseWrite.resolve()
    await expect(undoing).resolves.toBeUndefined()
    await reopening

    const final = await orm.em.fork().findOneOrFail(FormDistribution, { id: distribution.id })
    expect(waitingOnLock).toBe(1)
    expect(final.status).toBe('active')
  })

  it(`never loses an open when send undo and open race (${ROUNDS} rounds x ${PARALLEL})`, async () => {
    let lost = 0
    let total = 0
    for (let round = 0; round < ROUNDS; round += 1) {
      const ids = await Promise.all(Array.from({ length: PARALLEL }, () => seedSentInvitation()))
      await Promise.all(
        ids.map(async (invitationId) => {
          const undoFirst = Math.random() < 0.5
          const jitter = Math.floor(Math.random() * 4)
          const first = undoFirst ? () => undoSend(invitationId).catch(ignoreUndoConflict) : () => openInvitation(invitationId)
          const second = undoFirst ? () => openInvitation(invitationId) : () => undoSend(invitationId).catch(ignoreUndoConflict)
          await Promise.all([first(), delay(jitter).then(second)])
        }),
      )
      for (const invitationId of ids) {
        total += 1
        if ((await readInvitationStatus(invitationId)) !== 'opened') lost += 1
      }
    }
    console.info(`[forms undo race] stress: lost=${lost}/${total}`)
    expect(lost).toBe(0)
  })
})
