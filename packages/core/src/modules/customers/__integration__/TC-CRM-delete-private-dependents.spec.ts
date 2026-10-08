import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  expectOperation,
  redoOk,
  skipIfUndoTestsDisabled,
  undoOk,
} from '@open-mercato/core/helpers/integration/undoHarness'

/**
 * TC-CRM-delete-private-dependents: deleting a person or company must not be blocked by rows
 * that hold a foreign key to the record but are invisible to the deleting user, and undo must
 * bring those rows back.
 *
 * - `customer_label_assignments` are private to the user who assigned the label, so one user's
 *   label made another user's delete fail with `409 FOREIGN_KEY_VIOLATION`.
 * - Revoking an email-conversation share only sets `deleted_at` on
 *   `customer_email_conversation_shares`, so a person whose conversation was ever shared could
 *   never be deleted.
 */

const PEOPLE = '/api/customers/people'
const COMPANIES = '/api/customers/companies'

type LabelRow = { id: string; user_id: string; label_id: string; created_at: Date }
type ShareRow = { id: string; owner_user_id: string; created_at: Date; updated_at: Date | null; deleted_at: Date | null }

async function labelAssignmentsFor(entityId: string): Promise<LabelRow[]> {
  return withClient(async (client) => {
    const result = await client.query<LabelRow>(
      'select id, user_id, label_id, created_at from customer_label_assignments where entity_id = $1 order by id',
      [entityId],
    )
    return result.rows
  })
}

async function sharesFor(personId: string): Promise<ShareRow[]> {
  return withClient(async (client) => {
    const result = await client.query<ShareRow>(
      'select id, owner_user_id, created_at, updated_at, deleted_at from customer_email_conversation_shares where person_entity_id = $1 order by id',
      [personId],
    )
    return result.rows
  })
}

type InteractionRow = { id: string; visibility: string | null; location: string | null; duration_minutes: number | null }

async function interactionsFor(entityId: string): Promise<InteractionRow[]> {
  return withClient(async (client) => {
    const result = await client.query<InteractionRow>(
      'select id, visibility, location, duration_minutes from customer_interactions where entity_id = $1 order by id',
      [entityId],
    )
    return result.rows
  })
}

async function visibleInteractionIds(request: APIRequestContext, token: string, entityId: string): Promise<string[]> {
  const res = await apiRequest(request, 'GET', `/api/customers/interactions?entityId=${entityId}&pageSize=50`, { token })
  expect(res.ok(), `interactions list status ${res.status()}`).toBeTruthy()
  const body = (await readJsonSafe(res)) as { items?: Array<{ id?: string }> } | null
  return (body?.items ?? []).map((item) => item.id ?? '').filter(Boolean)
}

async function createPrivateEmail(
  request: APIRequestContext,
  token: string,
  entityId: string,
  title: string,
): Promise<string> {
  const res = await apiRequest(request, 'POST', '/api/customers/interactions', {
    token,
    data: {
      entityId,
      interactionType: 'email',
      title,
      visibility: 'private',
      status: 'done',
      location: 'Board room',
      durationMinutes: 25,
    },
  })
  expect(res.ok(), `private email status ${res.status()}`).toBeTruthy()
  const id = ((await readJsonSafe(res)) as { id?: string } | null)?.id
  expect(id, 'interaction id').toBeTruthy()
  return id as string
}

async function entityExists(entityId: string): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query('select 1 from customer_entities where id = $1', [entityId])
    return (result.rowCount ?? 0) > 0
  })
}

async function createEntity(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await apiRequest(request, 'POST', path, { token, data })
  expect(res.ok(), `create ${path} status ${res.status()}`).toBeTruthy()
  const body = (await readJsonSafe(res)) as { id?: string; entityId?: string } | null
  const id = body?.id ?? body?.entityId ?? null
  expect(id, `create ${path} returns an id`).toBeTruthy()
  return id as string
}

async function createAndAssignLabel(
  request: APIRequestContext,
  token: string,
  entityId: string,
  name: string,
): Promise<string> {
  const labelRes = await apiRequest(request, 'POST', '/api/customers/labels', { token, data: { label: name } })
  expect(labelRes.status(), 'label create').toBe(201)
  const labelId = ((await readJsonSafe(labelRes)) as { id?: string } | null)?.id
  expect(labelId, 'label id').toBeTruthy()
  const assignRes = await apiRequest(request, 'POST', '/api/customers/labels/assign', {
    token,
    data: { labelId, entityId },
  })
  expect(assignRes.status(), 'label assign').toBe(201)
  return labelId as string
}

async function assignedLabelIds(request: APIRequestContext, token: string, entityId: string): Promise<string[]> {
  const res = await apiRequest(request, 'GET', `/api/customers/labels?entityId=${entityId}`, { token })
  expect(res.ok(), `labels list status ${res.status()}`).toBeTruthy()
  const body = (await readJsonSafe(res)) as { assignedIds?: string[] } | null
  return body?.assignedIds ?? []
}

async function deleteLabels(labelIds: string[]): Promise<void> {
  if (!labelIds.length) return
  await withClient(async (client) => {
    await client.query('delete from customer_label_assignments where label_id = any($1::uuid[])', [labelIds])
    await client.query('delete from customer_labels where id = any($1::uuid[])', [labelIds])
  })
}

async function deleteQuietly(request: APIRequestContext, token: string, path: string, id: string | null) {
  if (!id) return
  await apiRequest(request, 'DELETE', `${path}?id=${id}`, { token }).catch(() => undefined)
}

test.describe('TC-CRM-delete-private-dependents', () => {
  test.beforeAll(() => {
    skipIfUndoTestsDisabled()
  })

  test('a company labelled privately by another user can be deleted; undo and redo carry the label', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const stamp = Date.now()
    let companyId: string | null = null
    const labelIds: string[] = []
    try {
      companyId = await createEntity(request, adminToken, COMPANIES, { displayName: `TC-DELPRIV Co ${stamp}` })
      const labelId = await createAndAssignLabel(request, employeeToken, companyId, `TC-DELPRIV ${stamp}`)
      labelIds.push(labelId)
      const mailId = await createPrivateEmail(request, adminToken, companyId, `Company mail ${stamp}`)
      const interactionsBefore = await interactionsFor(companyId)
      expect(interactionsBefore).toEqual([{ id: mailId, visibility: 'private', location: 'Board room', duration_minutes: 25 }])
      expect(await visibleInteractionIds(request, employeeToken, companyId), 'private email hidden from the employee').not.toContain(mailId)
      const before = await labelAssignmentsFor(companyId)
      expect(before).toHaveLength(1)
      expect(await assignedLabelIds(request, adminToken, companyId), 'the label is private to the employee').toEqual([])

      const deleteRes = await apiRequest(request, 'DELETE', `${COMPANIES}?id=${companyId}`, { token: adminToken })
      expect(deleteRes.status(), 'delete must not be blocked by another user\'s private label').toBe(200)
      const deleteOp = expectOperation(deleteRes, 'customers.companies.delete')
      expect(await entityExists(companyId), 'company row removed').toBe(false)
      expect(await labelAssignmentsFor(companyId), 'label assignment removed with the company').toEqual([])

      await undoOk(request, adminToken, deleteOp.undoToken, 'undo company delete')
      expect(await entityExists(companyId), 'company restored').toBe(true)
      expect(await labelAssignmentsFor(companyId), 'label assignment restored as it was').toEqual(before)
      expect(await assignedLabelIds(request, employeeToken, companyId)).toEqual([labelId])
      expect(await interactionsFor(companyId), 'private email restored with all its fields').toEqual(interactionsBefore)
      expect(await visibleInteractionIds(request, employeeToken, companyId), 'private email still hidden after undo').not.toContain(mailId)
      expect(await visibleInteractionIds(request, adminToken, companyId)).toContain(mailId)

      await redoOk(request, adminToken, deleteOp.logId, 'redo company delete')
      expect(await entityExists(companyId), 'company deleted again by redo').toBe(false)
      expect(await labelAssignmentsFor(companyId)).toEqual([])
      companyId = null
    } finally {
      await deleteLabels(labelIds)
      await deleteQuietly(request, adminToken, COMPANIES, companyId)
    }
  })

  test('a person with a label and a revoked email share can be deleted; undo restores both exactly', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    let personId: string | null = null
    const labelIds: string[] = []
    try {
      personId = await createEntity(request, adminToken, PEOPLE, {
        firstName: 'DelPriv',
        lastName: `Revoked ${stamp}`,
        displayName: `DelPriv Revoked ${stamp}`,
      })
      const employeeToken = await getAuthToken(request, 'employee')
      const labelId = await createAndAssignLabel(request, adminToken, personId, `TC-DELPRIV P ${stamp}`)
      labelIds.push(labelId)
      const mailId = await createPrivateEmail(request, adminToken, personId, `Mail ${stamp}`)
      for (const shared of [true, false]) {
        const shareRes = await apiRequest(request, 'PUT', `${PEOPLE}/${personId}/email-share`, {
          token: adminToken,
          data: { shared },
        })
        expect(shareRes.ok(), `share=${shared} status ${shareRes.status()}`).toBeTruthy()
      }
      const sharesBefore = await sharesFor(personId)
      expect(sharesBefore).toHaveLength(1)
      expect(sharesBefore[0].deleted_at, 'share revoked (row kept)').not.toBeNull()
      const labelsBefore = await labelAssignmentsFor(personId)
      const interactionsBefore = await interactionsFor(personId)
      expect(await visibleInteractionIds(request, employeeToken, personId), 'revoked share keeps the email private').not.toContain(mailId)

      const deleteRes = await apiRequest(request, 'DELETE', `${PEOPLE}?id=${personId}`, { token: adminToken })
      expect(deleteRes.status(), 'a revoked share and a label must not block the delete').toBe(200)
      const deleteOp = expectOperation(deleteRes, 'customers.people.delete')
      expect(await entityExists(personId)).toBe(false)
      expect(await sharesFor(personId)).toEqual([])
      expect(await labelAssignmentsFor(personId)).toEqual([])

      await undoOk(request, adminToken, deleteOp.undoToken, 'undo person delete')
      expect(await entityExists(personId), 'person restored').toBe(true)
      expect(await sharesFor(personId), 'revoked share restored and still revoked').toEqual(sharesBefore)
      expect(await labelAssignmentsFor(personId)).toEqual(labelsBefore)
      expect(await assignedLabelIds(request, adminToken, personId)).toEqual([labelId])
      expect(await interactionsFor(personId), 'private email restored with all its fields').toEqual(interactionsBefore)
      expect(await visibleInteractionIds(request, employeeToken, personId), 'email stays private after undo').not.toContain(mailId)
    } finally {
      await deleteLabels(labelIds)
      await deleteQuietly(request, adminToken, PEOPLE, personId)
    }
  })

  test('undoing a person delete keeps a private email private and keeps its details', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const stamp = Date.now()
    let personId: string | null = null
    try {
      personId = await createEntity(request, adminToken, PEOPLE, {
        firstName: 'DelPriv',
        lastName: `Private ${stamp}`,
        displayName: `DelPriv Private ${stamp}`,
      })
      const mailId = await createPrivateEmail(request, adminToken, personId, `Mail ${stamp}`)
      const interactionsBefore = await interactionsFor(personId)
      expect(interactionsBefore).toEqual([{ id: mailId, visibility: 'private', location: 'Board room', duration_minutes: 25 }])
      expect(await visibleInteractionIds(request, employeeToken, personId)).not.toContain(mailId)

      const deleteRes = await apiRequest(request, 'DELETE', `${PEOPLE}?id=${personId}`, { token: adminToken })
      expect(deleteRes.status()).toBe(200)
      const deleteOp = expectOperation(deleteRes, 'customers.people.delete')
      await undoOk(request, adminToken, deleteOp.undoToken, 'undo person delete')

      expect(await interactionsFor(personId), 'private email restored with all its fields').toEqual(interactionsBefore)
      expect(await visibleInteractionIds(request, employeeToken, personId), 'undo must not publish a private email').not.toContain(mailId)
    } finally {
      await deleteQuietly(request, adminToken, PEOPLE, personId)
    }
  })

  test('undoing the delete of a person with an active share keeps the conversation shared', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    let personId: string | null = null
    try {
      personId = await createEntity(request, adminToken, PEOPLE, {
        firstName: 'DelPriv',
        lastName: `Shared ${stamp}`,
        displayName: `DelPriv Shared ${stamp}`,
      })
      const employeeToken = await getAuthToken(request, 'employee')
      const mailId = await createPrivateEmail(request, adminToken, personId, `Mail ${stamp}`)
      const shareRes = await apiRequest(request, 'PUT', `${PEOPLE}/${personId}/email-share`, {
        token: adminToken,
        data: { shared: true },
      })
      expect(shareRes.ok(), `share status ${shareRes.status()}`).toBeTruthy()
      const sharesBefore = await sharesFor(personId)
      expect(sharesBefore).toHaveLength(1)
      expect(sharesBefore[0].deleted_at).toBeNull()
      expect(await visibleInteractionIds(request, employeeToken, personId), 'shared email visible to the team').toContain(mailId)

      const deleteRes = await apiRequest(request, 'DELETE', `${PEOPLE}?id=${personId}`, { token: adminToken })
      expect(deleteRes.status(), 'an active share must not block the delete').toBe(200)
      const deleteOp = expectOperation(deleteRes, 'customers.people.delete')
      expect(await sharesFor(personId)).toEqual([])

      await undoOk(request, adminToken, deleteOp.undoToken, 'undo person delete')
      expect(await sharesFor(personId), 'active share restored').toEqual(sharesBefore)
      const shareState = await apiRequest(request, 'GET', `${PEOPLE}/${personId}/email-share`, { token: adminToken })
      expect(shareState.ok()).toBeTruthy()
      const shareBody = (await readJsonSafe(shareState)) as { sharedByMe?: boolean } | null
      expect(shareBody?.sharedByMe, 'conversation is shared again after undo').toBe(true)
      expect(await visibleInteractionIds(request, employeeToken, personId), 'shared email visible again after undo').toContain(mailId)
    } finally {
      await deleteQuietly(request, adminToken, PEOPLE, personId)
    }
  })
})
