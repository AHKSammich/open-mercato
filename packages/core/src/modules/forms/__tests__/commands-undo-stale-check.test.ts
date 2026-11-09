import 'reflect-metadata'

jest.mock('../events', () => ({
  emitFormsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../events-payloads', () => ({
  formsEventPayloadSchemas: {},
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (
    em: { findOne: (...args: unknown[]) => unknown },
    entity: unknown,
    where: unknown,
    options: unknown,
  ) => em.findOne(entity, where, options),
  findWithDecryption: (
    em: { find: (...args: unknown[]) => unknown },
    entity: unknown,
    where: unknown,
    options: unknown,
  ) => em.find(entity, where, options),
}))

import { LockMode } from '@mikro-orm/core'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { archiveFormCommand, renameFormCommand, restoreFormCommand } from '../commands/form'
import { closeDistributionCommand, updateDistributionCommand } from '../commands/distribution'
import { archiveVersionCommand, updateDraftCommand } from '../commands/form-version'
import {
  createInvitationCommand,
  revokeInvitationCommand,
  sendInvitationCommand,
} from '../commands/invitation'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const recordId = '33333333-3333-4333-8333-333333333333'
const secondId = '44444444-4444-4444-8444-444444444444'

type Row = Record<string, unknown> & { id: string }

function createHarness(rows: Row[]) {
  const findOneCalls: Array<{ where: Record<string, unknown>; options: Record<string, unknown> | undefined }> = []
  const removed: string[] = []
  let flushes = 0
  const em = {
    fork: () => em,
    transactional: async <T>(callback: (tx: typeof em) => Promise<T>) => callback(em),
    findOne: jest.fn(async (_entity: unknown, where: Record<string, unknown>, options?: Record<string, unknown>) => {
      findOneCalls.push({ where, options })
      return rows.find((row) => row.id === where.id) ?? null
    }),
    find: jest.fn(async (_entity: unknown, where: { id: { $in: string[] } }) =>
      rows.filter((row) => where.id.$in.includes(row.id)),
    ),
    remove: (row: Row) => {
      removed.push(row.id)
    },
    flush: jest.fn(async () => {
      flushes += 1
    }),
  }
  const ctx = {
    container: {
      resolve: (key: string) => (key === 'em' ? em : undefined),
      hasRegistration: () => false,
    },
  } as unknown as CommandRuntimeContext
  return {
    em,
    ctx,
    findOneCalls,
    removed,
    flushCount: () => flushes,
  }
}

function logEntryFor(undo: Record<string, unknown>, scope: Record<string, string> = {}) {
  return { commandPayload: { undo }, ...scope }
}

async function runUndo(
  handler: CommandHandler<never, never>,
  ctx: CommandRuntimeContext,
  undo: Record<string, unknown>,
  scope: Record<string, string> = {},
): Promise<unknown> {
  if (!handler.undo) throw new Error('[internal] handler has no undo')
  return handler.undo({ logEntry: logEntryFor(undo, scope), ctx } as never)
}

async function expectUndoConflict(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    status: 409,
    body: { code: 'forms.errors.undo_conflict' },
  })
}

const asHandler = (handler: unknown) => handler as CommandHandler<never, never>

function formSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    organizationId,
    tenantId,
    key: 'patient-intake',
    name: 'Draft Intake Form',
    description: null,
    status: 'draft',
    currentPublishedVersionId: null,
    defaultLocale: 'en',
    supportedLocales: ['en'],
    retentionDays: null,
    createdBy: '55555555-5555-4555-8555-555555555555',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function formRow(snapshot: Record<string, unknown>): Row {
  return {
    ...snapshot,
    id: recordId,
    archivedAt: snapshot.archivedAt ? new Date(String(snapshot.archivedAt)) : null,
    createdAt: new Date(String(snapshot.createdAt)),
    updatedAt: new Date(String(snapshot.updatedAt)),
  }
}

function distributionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    organizationId,
    tenantId,
    formId: secondId,
    pinnedVersionId: null,
    mode: 'open',
    publicSlug: 'slug',
    status: 'active',
    title: 'Spring survey',
    defaultLocale: 'en',
    requireCustomerAuth: false,
    allowMultipleSubmissions: false,
    maxResponses: 10,
    responseCount: 0,
    opensAt: null,
    closesAt: '2026-03-01T00:00:00.000Z',
    redirectUrl: null,
    settings: { theme: 'light', layout: 'single' },
    createdBy: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function distributionRow(snapshot: Record<string, unknown>): Row {
  return {
    ...snapshot,
    id: recordId,
    opensAt: snapshot.opensAt ? new Date(String(snapshot.opensAt)) : null,
    closesAt: snapshot.closesAt ? new Date(String(snapshot.closesAt)) : null,
    createdAt: new Date(String(snapshot.createdAt)),
    updatedAt: new Date(String(snapshot.updatedAt)),
  }
}

function versionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    formId: secondId,
    organizationId,
    tenantId,
    versionNumber: 1,
    status: 'draft',
    schema: { type: 'object', properties: { first: { type: 'string' } } },
    uiSchema: {},
    roles: ['admin'],
    schemaHash: 'hash-1',
    registryVersion: 'r1',
    publishedAt: null,
    publishedBy: null,
    changelog: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function versionRow(snapshot: Record<string, unknown>): Row {
  return {
    ...snapshot,
    id: recordId,
    publishedAt: snapshot.publishedAt ? new Date(String(snapshot.publishedAt)) : null,
    archivedAt: snapshot.archivedAt ? new Date(String(snapshot.archivedAt)) : null,
    createdAt: new Date(String(snapshot.createdAt)),
    updatedAt: new Date(String(snapshot.updatedAt)),
  }
}

function invitationRow(id: string, overrides: Record<string, unknown> = {}): Row {
  return {
    id,
    organizationId,
    tenantId,
    status: 'pending',
    sentAt: null,
    sendCount: 0,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('forms undo refuses to overwrite a newer change', () => {
  describe('forms.form.rename', () => {
    const before = formSnapshot()
    const after = formSnapshot({ name: 'Patient Intake Form', updatedAt: '2026-01-01T00:05:00.000Z' })

    it('refuses the undo when the form was renamed again after the logged action', async () => {
      const row = formRow({ ...after, name: 'Patient Intake Form (Spanish)', updatedAt: '2026-01-02T00:00:00.000Z' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(renameFormCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.name).toBe('Patient Intake Form (Spanish)')
      expect(harness.flushCount()).toBe(0)
    })

    it('restores the previous name when nothing changed since the logged action', async () => {
      const row = formRow(after)
      const harness = createHarness([row])
      await runUndo(asHandler(renameFormCommand), harness.ctx, { before, after, staleCheck: true })
      expect(row.name).toBe('Draft Intake Form')
      expect(harness.flushCount()).toBe(1)
      expect(harness.findOneCalls[0]).toEqual({
        where: { id: recordId, tenantId, organizationId },
        options: { lockMode: LockMode.PESSIMISTIC_WRITE },
      })
    })

    it('ignores changes to fields the undo does not restore', async () => {
      const row = formRow({ ...after, status: 'active', currentPublishedVersionId: secondId })
      const harness = createHarness([row])
      await runUndo(asHandler(renameFormCommand), harness.ctx, { before, after, staleCheck: true })
      expect(row.name).toBe('Draft Intake Form')
      expect(row.status).toBe('active')
    })

    it('keeps the previous behaviour for log entries written before the stale check', async () => {
      const row = formRow({ ...after, name: 'Patient Intake Form (Spanish)' })
      const harness = createHarness([row])
      await runUndo(asHandler(renameFormCommand), harness.ctx, { before, after: before })
      expect(row.name).toBe('Draft Intake Form')
    })

    it('reads the after snapshot fresh instead of from the identity map', async () => {
      const row = formRow(after)
      const harness = createHarness([row])
      await renameFormCommand.captureAfter?.(
        { id: recordId, tenantId, organizationId } as never,
        { formId: recordId, updatedAt: after.updatedAt },
        harness.ctx,
      )
      expect(harness.findOneCalls[0]).toEqual({
        where: { id: recordId, tenantId, organizationId },
        options: { refresh: true },
      })
    })
  })

  describe('forms.form.archive and forms.form.restore', () => {
    it('refuses an archive undo after the form was restored and archived again', async () => {
      const before = formSnapshot({ status: 'active' })
      const after = formSnapshot({ status: 'archived', archivedAt: '2026-01-01T00:05:00.000Z' })
      const row = formRow({ ...after, archivedAt: '2026-01-03T00:00:00.000Z' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(archiveFormCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.status).toBe('archived')
    })

    it('refuses a restore undo after the form was archived by someone else', async () => {
      const before = formSnapshot({ status: 'archived', archivedAt: '2026-01-01T00:00:00.000Z' })
      const after = formSnapshot({ status: 'active' })
      const row = formRow({ ...after, status: 'archived', archivedAt: '2026-01-04T00:00:00.000Z' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(restoreFormCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect((row.archivedAt as Date).toISOString()).toBe('2026-01-04T00:00:00.000Z')
    })
  })

  describe('forms.distribution.update and forms.distribution.close', () => {
    it('refuses a close undo after the distribution was reopened', async () => {
      const before = distributionSnapshot()
      const after = distributionSnapshot({ status: 'closed' })
      const row = distributionRow({ ...after, status: 'active', maxResponses: 50 })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(closeDistributionCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.status).toBe('active')
    })

    it('refuses an update undo after a newer closesAt change', async () => {
      const before = distributionSnapshot()
      const after = distributionSnapshot({ maxResponses: 20 })
      const row = distributionRow({ ...after, closesAt: '2026-04-01T00:00:00.000Z' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(updateDistributionCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.maxResponses).toBe(20)
      expect((row.closesAt as Date).toISOString()).toBe('2026-04-01T00:00:00.000Z')
    })

    it('restores an update when only responses arrived and settings round-tripped through jsonb', async () => {
      const before = distributionSnapshot()
      const after = distributionSnapshot({ maxResponses: 20, settings: { layout: 'single', theme: 'light' } })
      const row = distributionRow({
        ...after,
        responseCount: 7,
        settings: { theme: 'light', layout: 'single', note: undefined },
      })
      const harness = createHarness([row])
      await runUndo(asHandler(updateDistributionCommand), harness.ctx, { before, after, staleCheck: true })
      expect(row.maxResponses).toBe(10)
      expect(row.responseCount).toBe(7)
    })
  })

  describe('forms.form_version.update_draft and forms.form_version.archive', () => {
    it('refuses a draft undo after a newer schema edit', async () => {
      const before = versionSnapshot()
      const after = versionSnapshot({ schema: { type: 'object', properties: { second: { type: 'string' } } }, schemaHash: 'hash-2' })
      const row = versionRow({ ...after, schema: { type: 'object', properties: { third: { type: 'string' } } }, schemaHash: 'hash-3' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(updateDraftCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.schemaHash).toBe('hash-3')
    })

    it('leaves a version that was published since the edit untouched', async () => {
      const before = versionSnapshot()
      const after = versionSnapshot({ schemaHash: 'hash-2' })
      const row = versionRow({ ...after, status: 'published' })
      const harness = createHarness([row])
      await runUndo(asHandler(updateDraftCommand), harness.ctx, { before, after, staleCheck: true })
      expect(row.schemaHash).toBe('hash-2')
      expect(harness.flushCount()).toBe(0)
    })

    it('refuses a version archive undo after the version was archived again later', async () => {
      const before = versionSnapshot({ status: 'published', publishedAt: '2026-01-01T00:00:00.000Z' })
      const after = versionSnapshot({ status: 'archived', archivedAt: '2026-01-02T00:00:00.000Z' })
      const row = versionRow({ ...after, archivedAt: '2026-01-05T00:00:00.000Z' })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(archiveVersionCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.status).toBe('archived')
    })
  })

  describe('forms.invitation.send and forms.invitation.revoke', () => {
    const before = { id: recordId, organizationId, tenantId, status: 'pending', sentAt: null, sendCount: 0 }
    const after = { ...before, status: 'sent', sentAt: '2026-01-01T00:05:00.000Z', sendCount: 1 }

    it('refuses a send undo after the recipient submitted the form', async () => {
      const row = invitationRow(recordId, { status: 'submitted', sentAt: new Date(after.sentAt), sendCount: 1 })
      const harness = createHarness([row])
      await expectUndoConflict(
        runUndo(asHandler(sendInvitationCommand), harness.ctx, { before, after, staleCheck: true }),
      )
      expect(row.status).toBe('submitted')
      expect(row.sendCount).toBe(1)
    })

    it('restores a send when the invitation is unchanged', async () => {
      const row = invitationRow(recordId, { status: 'sent', sentAt: new Date(after.sentAt), sendCount: 1 })
      const harness = createHarness([row])
      await runUndo(asHandler(sendInvitationCommand), harness.ctx, { before, after, staleCheck: true })
      expect(row).toMatchObject({ status: 'pending', sentAt: null, sendCount: 0 })
    })

    it('logs the after snapshot with the stale check marker', async () => {
      const log = await sendInvitationCommand.buildLog?.({
        input: {} as never,
        result: { invitationId: recordId },
        snapshots: { before, after },
        ctx: {} as never,
      } as never)
      expect(log?.payload).toEqual({ undo: { before, after, staleCheck: true } })
    })

    it('keeps the previous behaviour for send log entries written before the stale check', async () => {
      const row = invitationRow(recordId, { status: 'opened', sentAt: new Date(after.sentAt), sendCount: 1 })
      const harness = createHarness([row])
      await runUndo(asHandler(sendInvitationCommand), harness.ctx, { before })
      expect(row).toMatchObject({ status: 'pending', sentAt: null, sendCount: 0 })
    })

    it('restores a revoke when the invitation is still revoked', async () => {
      const row = invitationRow(recordId, { status: 'revoked' })
      const harness = createHarness([row])
      await runUndo(asHandler(revokeInvitationCommand), harness.ctx, {
        before: { id: recordId, organizationId, tenantId, status: 'sent' },
        after: { id: recordId, organizationId, tenantId, status: 'revoked' },
        staleCheck: true,
      })
      expect(row.status).toBe('sent')
    })
  })

  describe('forms.invitation.create', () => {
    const snapshots = [
      { id: recordId, organizationId, tenantId, status: 'sent', sentAt: '2026-01-01T00:05:00.000Z', sendCount: 1 },
      { id: secondId, organizationId, tenantId, status: 'pending', sentAt: null, sendCount: 0 },
    ]

    it('refuses to delete invitations when one was opened after creation', async () => {
      const rows = [
        invitationRow(recordId, { status: 'sent', sentAt: new Date(snapshots[0].sentAt as string), sendCount: 1 }),
        invitationRow(secondId, { status: 'opened' }),
      ]
      const harness = createHarness(rows)
      await expectUndoConflict(
        runUndo(asHandler(createInvitationCommand), harness.ctx, {
          invitationIds: [recordId, secondId],
          invitations: snapshots,
          staleCheck: true,
        }),
      )
      expect(harness.removed).toEqual([])
    })

    it('deletes the created invitations when none changed', async () => {
      const rows = [
        invitationRow(recordId, { status: 'sent', sentAt: new Date(snapshots[0].sentAt as string), sendCount: 1 }),
        invitationRow(secondId),
      ]
      const harness = createHarness(rows)
      await runUndo(
        asHandler(createInvitationCommand),
        harness.ctx,
        { invitationIds: [recordId, secondId], invitations: snapshots, staleCheck: true },
        { tenantId, organizationId },
      )
      expect(harness.removed).toEqual([recordId, secondId])
      expect(harness.em.find).toHaveBeenCalledWith(
        expect.anything(),
        { id: { $in: [recordId, secondId] }, tenantId, organizationId },
        { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
      )
    })

    it('keeps deleting for log entries written before the stale check', async () => {
      const rows = [invitationRow(recordId, { status: 'opened' })]
      const harness = createHarness(rows)
      await runUndo(asHandler(createInvitationCommand), harness.ctx, { invitationIds: [recordId] })
      expect(harness.removed).toEqual([recordId])
    })
  })
})
