import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { E } from '#generated/entities.ids.generated'
import {
  CustomerEmailConversationShare,
  CustomerEntity,
  CustomerInteraction,
  CustomerLabel,
  CustomerLabelAssignment,
} from '../data/entities'
import type { QueryIndexEventEntry } from './shared'

type SnapshotDate = Date | string

export type LabelAssignmentRestoreSnapshot = {
  id: string
  labelId: string
  userId: string
  createdAt: SnapshotDate
}

export type EmailConversationShareRestoreSnapshot = {
  id: string
  ownerUserId: string
  sharedByUserId: string
  createdAt: SnapshotDate
  updatedAt: SnapshotDate | null
  deletedAt: SnapshotDate | null
}

/**
 * Rows that reference a customer entity through a foreign key but belong to individual users
 * (private labels, email-conversation share grants). They are captured inside the delete
 * transaction, so the undo payload holds exactly the rows the delete removed.
 */
export type EntityPrivateDependentsSnapshot = {
  labelAssignments?: LabelAssignmentRestoreSnapshot[]
  emailConversationShares?: EmailConversationShareRestoreSnapshot[]
}

export type InteractionDetailsSnapshot = {
  durationMinutes?: number | null
  location?: string | null
  allDay?: boolean | null
  recurrenceRule?: string | null
  recurrenceEnd?: SnapshotDate | null
  participants?: CustomerInteraction['participants']
  reminderMinutes?: number | null
  visibility?: string | null
  linkedEntities?: CustomerInteraction['linkedEntities']
  guestPermissions?: CustomerInteraction['guestPermissions']
  pinned?: boolean
  channelId?: string | null
  channelProviderKey?: string | null
  externalMessageId?: string | null
}

function toDate(value: SnapshotDate): Date {
  return value instanceof Date ? value : new Date(value)
}

function toOptionalDate(value: SnapshotDate | null | undefined): Date | null {
  return value === null || value === undefined ? null : toDate(value)
}

function referenceId(value: string | { id: string }): string {
  return typeof value === 'string' ? value : value.id
}

function entityScope(entity: CustomerEntity) {
  return { organizationId: entity.organizationId, tenantId: entity.tenantId }
}

export function captureInteractionDetails(interaction: CustomerInteraction): Required<InteractionDetailsSnapshot> {
  return {
    durationMinutes: interaction.durationMinutes ?? null,
    location: interaction.location ?? null,
    allDay: interaction.allDay ?? null,
    recurrenceRule: interaction.recurrenceRule ?? null,
    recurrenceEnd: interaction.recurrenceEnd ?? null,
    participants: interaction.participants ?? null,
    reminderMinutes: interaction.reminderMinutes ?? null,
    visibility: interaction.visibility ?? null,
    linkedEntities: interaction.linkedEntities ?? null,
    guestPermissions: interaction.guestPermissions ?? null,
    pinned: interaction.pinned === true,
    channelId: interaction.channelId ?? null,
    channelProviderKey: interaction.channelProviderKey ?? null,
    externalMessageId: interaction.externalMessageId ?? null,
  }
}

export function restoreInteractionDetails(snapshot: InteractionDetailsSnapshot) {
  return {
    durationMinutes: snapshot.durationMinutes ?? null,
    location: snapshot.location ?? null,
    allDay: snapshot.allDay ?? null,
    recurrenceRule: snapshot.recurrenceRule ?? null,
    recurrenceEnd: toOptionalDate(snapshot.recurrenceEnd),
    participants: snapshot.participants ?? null,
    reminderMinutes: snapshot.reminderMinutes ?? null,
    visibility: snapshot.visibility ?? null,
    linkedEntities: snapshot.linkedEntities ?? null,
    guestPermissions: snapshot.guestPermissions ?? null,
    pinned: snapshot.pinned === true,
    channelId: snapshot.channelId ?? null,
    channelProviderKey: snapshot.channelProviderKey ?? null,
    externalMessageId: snapshot.externalMessageId ?? null,
  }
}

export async function removeEntityPrivateDependents(
  em: EntityManager,
  entity: CustomerEntity,
): Promise<Required<EntityPrivateDependentsSnapshot>> {
  const scope = entityScope(entity)
  const labelAssignments = await findWithDecryption(
    em,
    CustomerLabelAssignment,
    { entity, ...scope },
    { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
    scope,
  )
  const shares = entity.kind === 'person'
    ? await findWithDecryption(
        em,
        CustomerEmailConversationShare,
        { personEntity: entity, ...scope },
        { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
        scope,
      )
    : []
  if (labelAssignments.length) {
    await em.nativeDelete(CustomerLabelAssignment, { id: { $in: labelAssignments.map((row) => row.id) }, ...scope })
  }
  if (shares.length) {
    await em.nativeDelete(CustomerEmailConversationShare, { id: { $in: shares.map((row) => row.id) }, ...scope })
  }
  return {
    labelAssignments: labelAssignments.map((row) => ({
      id: row.id,
      labelId: referenceId(row.label),
      userId: row.userId,
      createdAt: row.createdAt,
    })),
    emailConversationShares: shares.map((row) => ({
      id: row.id,
      ownerUserId: row.ownerUserId,
      sharedByUserId: row.sharedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt ?? null,
      deletedAt: row.deletedAt ?? null,
    })),
  }
}

export async function restoreEntityPrivateDependents(
  em: EntityManager,
  entity: CustomerEntity,
  snapshot: EntityPrivateDependentsSnapshot | null | undefined,
): Promise<LabelAssignmentRestoreSnapshot[]> {
  const scope = entityScope(entity)
  const restoredLabelAssignments: LabelAssignmentRestoreSnapshot[] = []
  if (Array.isArray(snapshot?.labelAssignments)) {
    await em.nativeDelete(CustomerLabelAssignment, { entity, ...scope })
    const labelIds = Array.from(new Set(snapshot.labelAssignments.map((row) => row.labelId)))
    const labels = labelIds.length
      ? await findWithDecryption(em, CustomerLabel, { id: { $in: labelIds }, ...scope }, undefined, scope)
      : []
    const labelsById = new Map(labels.map((label) => [label.id, label]))
    for (const row of snapshot.labelAssignments) {
      const label = labelsById.get(row.labelId)
      if (!label || label.userId !== row.userId) continue
      em.persist(em.create(CustomerLabelAssignment, {
        id: row.id,
        ...scope,
        userId: row.userId,
        label,
        entity,
        createdAt: toDate(row.createdAt),
      }))
      restoredLabelAssignments.push(row)
    }
  }
  if (entity.kind === 'person' && Array.isArray(snapshot?.emailConversationShares)) {
    await em.nativeDelete(CustomerEmailConversationShare, { personEntity: entity, ...scope })
    for (const row of snapshot.emailConversationShares) {
      em.persist(em.create(CustomerEmailConversationShare, {
        id: row.id,
        ...scope,
        personEntity: entity,
        ownerUserId: row.ownerUserId,
        sharedByUserId: row.sharedByUserId,
        createdAt: toDate(row.createdAt),
        updatedAt: toOptionalDate(row.updatedAt),
        deletedAt: toOptionalDate(row.deletedAt),
      }))
    }
  }
  return restoredLabelAssignments
}

export function labelAssignmentIndexEntries(
  entity: Pick<CustomerEntity, 'organizationId' | 'tenantId'>,
  rows: LabelAssignmentRestoreSnapshot[] | null | undefined,
): QueryIndexEventEntry[] {
  return (rows ?? []).map((row) => ({
    entityType: E.customers.customer_label_assignment,
    recordId: row.id,
    tenantId: entity.tenantId,
    organizationId: entity.organizationId,
  }))
}
