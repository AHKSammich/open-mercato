import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { FormDistribution, FormInvitation } from '../data/entities'
import {
  invitationCreateCommandSchema,
  invitationRevokeCommandSchema,
  invitationSendCommandSchema,
  type FormInvitationCreateCommandInput,
  type FormInvitationRevokeCommandInput,
  type FormInvitationSendCommandInput,
} from '../data/validators'
import {
  generateRawInvitationToken,
  getInvitationTokenTtlSeconds,
  hashInvitationToken,
} from '../services/distribution-token'
import { enqueueInvitationEmail } from '../subscribers/invitation-email'
import {
  applyStaleCheckedUndo,
  emitForms,
  ensureOrganizationScope,
  ensureTenantScope,
  extractUndoPayload,
  hasUndoTargetChanged,
  invalidateFormsCacheTags,
  resolveActorUserId,
  resolveEntityManager,
  throwFormsUndoConflict,
  type FormsStaleCheckedUndoPayload,
} from './shared'
import { DISTRIBUTION_CACHE_TAGS } from './distribution'

export const FORM_INVITATION_RESOURCE_KIND = 'forms.invitation'

// ----------------------------------------------------------------------------
// Snapshots + undo payloads
// ----------------------------------------------------------------------------

type FormInvitationSendSnapshot = {
  id: string
  organizationId: string
  tenantId: string
  status: FormInvitation['status']
  sentAt: string | null
  sendCount: number
}

type FormInvitationStatusSnapshot = {
  id: string
  organizationId: string
  tenantId: string
  status: FormInvitation['status']
}

type FormInvitationSendUndoPayload = FormsStaleCheckedUndoPayload<FormInvitationSendSnapshot> & {
  before?: FormInvitationSendSnapshot | null
}

type FormInvitationRevokeUndoPayload = FormsStaleCheckedUndoPayload<FormInvitationStatusSnapshot> & {
  before?: FormInvitationStatusSnapshot | null
}

type FormInvitationCreateUndoPayload = {
  invitationIds?: string[]
  invitations?: FormInvitationSendSnapshot[]
  staleCheck?: boolean
}

const INVITATION_SEND_UNDO_FIELDS = ['status', 'sentAt', 'sendCount'] as const
const INVITATION_REVOKE_UNDO_FIELDS = ['status'] as const

function serializeInvitationSendSnapshot(invitation: FormInvitation): FormInvitationSendSnapshot {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    tenantId: invitation.tenantId,
    status: invitation.status,
    sentAt: invitation.sentAt ? invitation.sentAt.toISOString() : null,
    sendCount: invitation.sendCount,
  }
}

function serializeInvitationStatusSnapshot(invitation: FormInvitation): FormInvitationStatusSnapshot {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    tenantId: invitation.tenantId,
    status: invitation.status,
  }
}

async function findInvitationAfterCommand(
  ctx: CommandRuntimeContext,
  invitationId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<FormInvitation | null> {
  return findOneWithDecryption(
    resolveEntityManager(ctx),
    FormInvitation,
    { id: invitationId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { refresh: true },
    scope,
  )
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function resolveAppUrl(): string | null {
  const raw = process.env.APP_URL?.trim()
  if (!raw) return null
  return raw.replace(/\/$/, '')
}

function buildPersonalLink(rawToken: string): string | null {
  const base = resolveAppUrl()
  if (!base) return null
  return `${base}/i/${rawToken}`
}

async function findDistributionInScope(
  em: EntityManager,
  distributionId: string,
  tenantId: string,
  organizationId: string,
): Promise<FormDistribution> {
  const distribution = await em.findOne(FormDistribution, {
    id: distributionId,
    tenantId,
    organizationId,
    deletedAt: null,
  })
  if (!distribution) {
    throw new CrudHttpError(404, { error: 'forms.errors.distribution_not_found' })
  }
  return distribution
}

async function findInvitationInScope(
  em: EntityManager,
  invitationId: string,
  tenantId: string,
  organizationId: string,
): Promise<FormInvitation> {
  const invitation = await findOneWithDecryption(
    em,
    FormInvitation,
    { id: invitationId, tenantId, organizationId, deletedAt: null },
    undefined,
    { tenantId, organizationId },
  )
  if (!invitation) {
    throw new CrudHttpError(404, { error: 'forms.errors.invitation_not_found' })
  }
  return invitation
}

// ----------------------------------------------------------------------------
// forms.invitation.create — bulk
// ----------------------------------------------------------------------------

type InvitationCreateResult = {
  invitations: Array<{ id: string; rawToken: string | null }>
}

const createInvitationCommand: CommandHandler<FormInvitationCreateCommandInput, InvitationCreateResult> = {
  id: 'forms.invitation.create',
  async execute(rawInput, ctx) {
    const parsed = invitationCreateCommandSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)

    const actorUserId = resolveActorUserId(ctx)
    const em = resolveEntityManager(ctx).fork()
    const distribution = await findDistributionInScope(
      em,
      parsed.distributionId,
      parsed.tenantId,
      parsed.organizationId,
    )

    const isPersonal = distribution.mode === 'personal'
    const now = new Date()
    const ttlSeconds = getInvitationTokenTtlSeconds()

    const created: Array<{ invitation: FormInvitation; rawToken: string | null }> = []
    for (const recipient of parsed.recipients) {
      const rawToken = isPersonal ? generateRawInvitationToken() : null
      const expiresAt = recipient.expiresAt
        ? new Date(recipient.expiresAt)
        : isPersonal
          ? new Date(now.getTime() + ttlSeconds * 1000)
          : null
      const invitation = em.create(FormInvitation, {
        distributionId: distribution.id,
        organizationId: parsed.organizationId,
        tenantId: parsed.tenantId,
        recipientEmail: recipient.email?.trim() ?? null,
        recipientName: recipient.name?.trim() ?? null,
        recipientRef: recipient.ref?.trim() ?? null,
        role: recipient.role ?? null,
        tokenHash: rawToken ? hashInvitationToken(rawToken) : null,
        status: 'pending',
        submissionId: null,
        locale: recipient.locale ?? null,
        expiresAt,
        sentAt: null,
        openedAt: null,
        startedAt: null,
        submittedAt: null,
        sendCount: 0,
        lastError: null,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      } as never)
      em.persist(invitation)
      created.push({ invitation, rawToken })
    }

    await em.flush()

    for (const entry of created) {
      await emitForms('forms.invitation.created', {
        invitationId: entry.invitation.id,
        distributionId: distribution.id,
      })
    }

    // Inline best-effort personal-link email for recipients that supplied an
    // email. This is the only point where the raw token is available; the
    // subscriber resend path cannot rebuild the link.
    for (const entry of created) {
      const email = entry.invitation.recipientEmail?.trim()
      if (!email || !entry.rawToken) continue
      const link = buildPersonalLink(entry.rawToken)
      const delivered = await enqueueInvitationEmail({
        em,
        invitation: entry.invitation,
        recipientEmail: email,
        link,
      })
      if (delivered) {
        entry.invitation.status = 'sent'
        entry.invitation.sentAt = new Date()
        entry.invitation.sendCount += 1
        await em.flush()
        await emitForms('forms.invitation.sent', {
          invitationId: entry.invitation.id,
          distributionId: distribution.id,
        })
      }
    }

    await invalidateFormsCacheTags(ctx, [
      DISTRIBUTION_CACHE_TAGS.distribution(distribution.id),
    ])

    return {
      invitations: created.map((entry) => ({ id: entry.invitation.id, rawToken: entry.rawToken })),
    }
  },
  captureAfter: async (input, result, ctx) => {
    const ids = result.invitations.map((entry) => entry.id)
    if (ids.length === 0) return []
    const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
    const invitations = await findWithDecryption(
      resolveEntityManager(ctx),
      FormInvitation,
      { id: { $in: ids }, ...scope },
      { refresh: true },
      scope,
    )
    return invitations.map(serializeInvitationSendSnapshot)
  },
  buildLog: async ({ input, result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const after = Array.isArray(snapshots.after) ? (snapshots.after as FormInvitationSendSnapshot[]) : null
    return {
      actionLabel: translate('forms.audit.invitation.create', 'Create invitation'),
      resourceKind: FORM_INVITATION_RESOURCE_KIND,
      resourceId: input.distributionId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      payload: {
        undo: {
          invitationIds: result.invitations.map((entry) => entry.id),
          ...(after ? { invitations: after, staleCheck: true } : {}),
        } satisfies FormInvitationCreateUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<FormInvitationCreateUndoPayload>(logEntry)
    const ids = payload?.invitationIds
    if (!ids || ids.length === 0) return
    const expectedById = new Map(
      (payload?.staleCheck ? payload.invitations ?? [] : []).map((snapshot) => [snapshot.id, snapshot]),
    )
    const em = resolveEntityManager(ctx).fork()
    const stale = await em.transactional(async (tx) => {
      const invitations = await findWithDecryption(
        tx,
        FormInvitation,
        { id: { $in: ids } },
        { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
      )
      const changed = invitations.some((invitation) => {
        const expected = expectedById.get(invitation.id)
        return expected
          ? hasUndoTargetChanged(serializeInvitationSendSnapshot(invitation), expected, INVITATION_SEND_UNDO_FIELDS)
          : false
      })
      if (changed) return true
      for (const invitation of invitations) {
        tx.remove(invitation)
      }
      await tx.flush()
      return false
    })
    if (stale) await throwFormsUndoConflict()
  },
}

// ----------------------------------------------------------------------------
// forms.invitation.send — also the resend path
// ----------------------------------------------------------------------------

const sendInvitationCommand: CommandHandler<FormInvitationSendCommandInput, { invitationId: string }> = {
  id: 'forms.invitation.send',
  async prepare(rawInput, ctx) {
    const parsed = invitationSendCommandSchema.parse(rawInput)
    const em = resolveEntityManager(ctx)
    const invitation = await em.findOne(FormInvitation, {
      id: parsed.invitationId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      deletedAt: null,
    })
    if (!invitation) return {}
    return { before: serializeInvitationSendSnapshot(invitation) }
  },
  async execute(rawInput, ctx) {
    const parsed = invitationSendCommandSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)

    const em = resolveEntityManager(ctx).fork()
    const invitation = await findInvitationInScope(
      em,
      parsed.invitationId,
      parsed.tenantId,
      parsed.organizationId,
    )

    if (invitation.status === 'revoked') {
      throw new CrudHttpError(409, { error: 'forms.errors.invitation_revoked' })
    }
    if (invitation.status === 'submitted') {
      throw new CrudHttpError(409, { error: 'forms.errors.invitation_submitted' })
    }
    const recipientEmail = invitation.recipientEmail?.trim()
    if (!recipientEmail) {
      throw new CrudHttpError(422, { error: 'forms.errors.invitation_no_email' })
    }

    if (invitation.status === 'pending' || invitation.status === 'opened') {
      invitation.status = 'sent'
    }
    invitation.sentAt = new Date()
    invitation.sendCount += 1
    invitation.updatedAt = new Date()
    await em.flush()

    await emitForms('forms.invitation.sent', {
      invitationId: invitation.id,
      distributionId: invitation.distributionId,
    })

    await invalidateFormsCacheTags(ctx, [
      DISTRIBUTION_CACHE_TAGS.distribution(invitation.distributionId),
    ])

    return { invitationId: invitation.id }
  },
  captureAfter: async (input, result, ctx) => {
    const invitation = await findInvitationAfterCommand(ctx, result.invitationId, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    })
    return invitation ? serializeInvitationSendSnapshot(invitation) : null
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as FormInvitationSendSnapshot | undefined
    const after = snapshots.after as FormInvitationSendSnapshot | undefined
    return {
      actionLabel: translate('forms.audit.invitation.send', 'Send invitation'),
      resourceKind: FORM_INVITATION_RESOURCE_KIND,
      resourceId: result.invitationId,
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      payload: {
        undo: {
          before: before ?? null,
          after: after ?? null,
          staleCheck: true,
        } satisfies FormInvitationSendUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<FormInvitationSendUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    await applyStaleCheckedUndo({
      ctx,
      entity: FormInvitation,
      target: before,
      payload,
      serialize: serializeInvitationSendSnapshot,
      fields: INVITATION_SEND_UNDO_FIELDS,
      apply: (record) => {
        record.status = before.status
        record.sentAt = before.sentAt ? new Date(before.sentAt) : null
        record.sendCount = before.sendCount
        record.updatedAt = new Date()
        return true
      },
    })
  },
}

// ----------------------------------------------------------------------------
// forms.invitation.revoke — soft revoke (row retained, status only)
// ----------------------------------------------------------------------------

const revokeInvitationCommand: CommandHandler<FormInvitationRevokeCommandInput, { invitationId: string }> = {
  id: 'forms.invitation.revoke',
  async prepare(rawInput, ctx) {
    const parsed = invitationRevokeCommandSchema.parse(rawInput)
    const em = resolveEntityManager(ctx)
    const invitation = await em.findOne(FormInvitation, {
      id: parsed.invitationId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      deletedAt: null,
    })
    if (!invitation) return {}
    return { before: serializeInvitationStatusSnapshot(invitation) }
  },
  async execute(rawInput, ctx) {
    const parsed = invitationRevokeCommandSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)

    const em = resolveEntityManager(ctx).fork()
    const invitation = await em.findOne(FormInvitation, {
      id: parsed.invitationId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      deletedAt: null,
    })
    if (!invitation) {
      throw new CrudHttpError(404, { error: 'forms.errors.invitation_not_found' })
    }

    if (invitation.status !== 'revoked') {
      invitation.status = 'revoked'
      invitation.updatedAt = new Date()
      await em.flush()
      await emitForms('forms.invitation.revoked', { invitationId: invitation.id })
      await invalidateFormsCacheTags(ctx, [
        DISTRIBUTION_CACHE_TAGS.distribution(invitation.distributionId),
      ])
    }

    return { invitationId: invitation.id }
  },
  captureAfter: async (input, result, ctx) => {
    const invitation = await findInvitationAfterCommand(ctx, result.invitationId, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
    })
    return invitation ? serializeInvitationStatusSnapshot(invitation) : null
  },
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as FormInvitationStatusSnapshot | undefined
    const after = snapshots.after as FormInvitationStatusSnapshot | undefined
    return {
      actionLabel: translate('forms.audit.invitation.revoke', 'Revoke invitation'),
      resourceKind: FORM_INVITATION_RESOURCE_KIND,
      resourceId: result.invitationId,
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      payload: {
        undo: {
          before: before ?? null,
          after: after ?? null,
          staleCheck: true,
        } satisfies FormInvitationRevokeUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<FormInvitationRevokeUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    await applyStaleCheckedUndo({
      ctx,
      entity: FormInvitation,
      target: before,
      payload,
      serialize: serializeInvitationStatusSnapshot,
      fields: INVITATION_REVOKE_UNDO_FIELDS,
      apply: (record) => {
        record.status = before.status
        record.updatedAt = new Date()
        return true
      },
    })
  },
}

registerCommand(createInvitationCommand)
registerCommand(sendInvitationCommand)
registerCommand(revokeInvitationCommand)

export {
  createInvitationCommand,
  sendInvitationCommand,
  revokeInvitationCommand,
}
