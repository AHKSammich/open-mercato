const mockFindWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => mockFindWithDecryption(...args),
}))

import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerEmailConversationShare,
  CustomerEntity,
  CustomerInteraction,
  CustomerLabelAssignment,
} from '../../data/entities'
import {
  captureInteractionDetails,
  labelAssignmentIndexEntries,
  removeEntityPrivateDependents,
  restoreEntityPrivateDependents,
  restoreInteractionDetails,
} from '../entityDeleteDependents'

const ORG_ID = 'org-1'
const TENANT_ID = 'tenant-1'
const SCOPE = { organizationId: ORG_ID, tenantId: TENANT_ID }

function makeEntity(kind: 'person' | 'company'): CustomerEntity {
  return { id: `${kind}-1`, kind, organizationId: ORG_ID, tenantId: TENANT_ID } as CustomerEntity
}

function makeEm() {
  const created: Array<{ entityClass: unknown; data: Record<string, unknown> }> = []
  const em = {
    nativeDelete: jest.fn(async () => 0),
    create: jest.fn((entityClass: unknown, data: Record<string, unknown>) => {
      created.push({ entityClass, data })
      return data
    }),
    persist: jest.fn(),
  }
  return { em, created, asEm: em as unknown as EntityManager }
}

describe('removeEntityPrivateDependents', () => {
  beforeEach(() => {
    mockFindWithDecryption.mockReset()
  })

  it('locks and deletes only rows in the entity scope and returns them for undo', async () => {
    const { em, asEm } = makeEm()
    const person = makeEntity('person')
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const revokedAt = new Date('2026-02-01T00:00:00.000Z')
    mockFindWithDecryption
      .mockResolvedValueOnce([{ id: 'la-1', label: { id: 'label-1' }, userId: 'user-a', createdAt }])
      .mockResolvedValueOnce([
        { id: 'share-1', ownerUserId: 'user-a', sharedByUserId: 'user-a', createdAt, updatedAt: revokedAt, deletedAt: revokedAt },
      ])

    const removed = await removeEntityPrivateDependents(asEm, person)

    expect(mockFindWithDecryption).toHaveBeenNthCalledWith(
      1,
      asEm,
      CustomerLabelAssignment,
      { entity: person, ...SCOPE },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
      SCOPE,
    )
    expect(mockFindWithDecryption).toHaveBeenNthCalledWith(
      2,
      asEm,
      CustomerEmailConversationShare,
      { personEntity: person, ...SCOPE },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
      SCOPE,
    )
    expect(em.nativeDelete).toHaveBeenCalledWith(CustomerLabelAssignment, { id: { $in: ['la-1'] }, ...SCOPE })
    expect(em.nativeDelete).toHaveBeenCalledWith(CustomerEmailConversationShare, { id: { $in: ['share-1'] }, ...SCOPE })
    expect(removed).toEqual({
      labelAssignments: [{ id: 'la-1', labelId: 'label-1', userId: 'user-a', createdAt }],
      emailConversationShares: [
        { id: 'share-1', ownerUserId: 'user-a', sharedByUserId: 'user-a', createdAt, updatedAt: revokedAt, deletedAt: revokedAt },
      ],
    })
  })

  it('does not look up email shares for a company and skips deletes when nothing references the entity', async () => {
    const { em, asEm } = makeEm()
    mockFindWithDecryption.mockResolvedValueOnce([])

    const removed = await removeEntityPrivateDependents(asEm, makeEntity('company'))

    expect(mockFindWithDecryption).toHaveBeenCalledTimes(1)
    expect(em.nativeDelete).not.toHaveBeenCalled()
    expect(removed).toEqual({ labelAssignments: [], emailConversationShares: [] })
  })
})

describe('restoreEntityPrivateDependents', () => {
  beforeEach(() => {
    mockFindWithDecryption.mockReset()
  })

  it('restores assignments whose label still exists for the same owner and every share with its dates', async () => {
    const { em, created, asEm } = makeEm()
    const person = makeEntity('person')
    const label = { id: 'label-1', userId: 'user-a' }
    mockFindWithDecryption.mockResolvedValueOnce([label, { id: 'label-2', userId: 'user-other' }])

    const restored = await restoreEntityPrivateDependents(asEm, person, {
      labelAssignments: [
        { id: 'la-1', labelId: 'label-1', userId: 'user-a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'la-2', labelId: 'label-2', userId: 'user-b', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'la-3', labelId: 'label-missing', userId: 'user-a', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      emailConversationShares: [
        {
          id: 'share-1',
          ownerUserId: 'user-a',
          sharedByUserId: 'user-a',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
          deletedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    })

    expect(em.nativeDelete).toHaveBeenCalledWith(CustomerLabelAssignment, { entity: person, ...SCOPE })
    expect(em.nativeDelete).toHaveBeenCalledWith(CustomerEmailConversationShare, { personEntity: person, ...SCOPE })
    expect(mockFindWithDecryption.mock.calls[0][2]).toEqual({ id: { $in: ['label-1', 'label-2', 'label-missing'] }, ...SCOPE })
    expect(restored.map((row) => row.id)).toEqual(['la-1'])
    expect(created).toEqual([
      {
        entityClass: CustomerLabelAssignment,
        data: {
          id: 'la-1',
          ...SCOPE,
          userId: 'user-a',
          label,
          entity: person,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
      {
        entityClass: CustomerEmailConversationShare,
        data: {
          id: 'share-1',
          ...SCOPE,
          personEntity: person,
          ownerUserId: 'user-a',
          sharedByUserId: 'user-a',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
          deletedAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      },
    ])
  })

  it('leaves current rows untouched for undo payloads written before the dependents were captured', async () => {
    const { em, created, asEm } = makeEm()

    const restored = await restoreEntityPrivateDependents(asEm, makeEntity('person'), undefined)

    expect(restored).toEqual([])
    expect(em.nativeDelete).not.toHaveBeenCalled()
    expect(mockFindWithDecryption).not.toHaveBeenCalled()
    expect(created).toEqual([])
  })

  it('never restores email shares onto a company', async () => {
    const { em, created, asEm } = makeEm()

    await restoreEntityPrivateDependents(asEm, makeEntity('company'), {
      emailConversationShares: [
        { id: 'share-1', ownerUserId: 'user-a', sharedByUserId: 'user-a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: null, deletedAt: null },
      ],
    })

    expect(em.nativeDelete).not.toHaveBeenCalled()
    expect(created).toEqual([])
  })
})

describe('interaction details', () => {
  it('round-trips the visibility and channel columns through a JSON snapshot', () => {
    const interaction = {
      durationMinutes: 25,
      location: 'Board room',
      allDay: false,
      recurrenceRule: null,
      recurrenceEnd: new Date('2026-03-01T00:00:00.000Z'),
      participants: [{ userId: 'user-a', status: 'accepted' }],
      reminderMinutes: 10,
      visibility: 'private',
      linkedEntities: null,
      guestPermissions: { canSeeList: true },
      pinned: true,
      channelId: 'channel-1',
      channelProviderKey: 'gmail',
      externalMessageId: 'message-1',
    } as unknown as CustomerInteraction

    const snapshot = JSON.parse(JSON.stringify(captureInteractionDetails(interaction)))

    expect(restoreInteractionDetails(snapshot)).toEqual({
      ...captureInteractionDetails(interaction),
      recurrenceEnd: new Date('2026-03-01T00:00:00.000Z'),
    })
  })

  it('restores legacy snapshots without the new keys as before', () => {
    expect(restoreInteractionDetails({})).toEqual({
      durationMinutes: null,
      location: null,
      allDay: null,
      recurrenceRule: null,
      recurrenceEnd: null,
      participants: null,
      reminderMinutes: null,
      visibility: null,
      linkedEntities: null,
      guestPermissions: null,
      pinned: false,
      channelId: null,
      channelProviderKey: null,
      externalMessageId: null,
    })
  })
})

describe('labelAssignmentIndexEntries', () => {
  it('maps rows to scoped query-index entries', () => {
    expect(labelAssignmentIndexEntries(SCOPE, [{ id: 'la-1', labelId: 'label-1', userId: 'user-a', createdAt: new Date() }])).toEqual([
      { entityType: 'customers:customer_label_assignment', recordId: 'la-1', ...SCOPE },
    ])
    expect(labelAssignmentIndexEntries(SCOPE, undefined)).toEqual([])
  })
})
