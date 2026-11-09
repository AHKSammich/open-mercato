import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken, withCredentialIsolatedRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createDistributionFixture,
  createFormFixture,
  createInvitationsFixture,
  createPublishedFormFixture,
  deleteDistributionIfExists,
  deleteFormIfExists,
  listInvitations,
  patchDistribution,
  readDistribution,
} from '@open-mercato/core/helpers/integration/formsFixtures'
import { expectOperation, skipIfUndoTestsDisabled, undoByToken, undoOk } from '@open-mercato/core/helpers/integration/undoHarness'

/**
 * TC-FORMS-LOCK-002 — forms undo refuses once the record changed after the logged action.
 *
 * Undo writes back the snapshot taken before the action. When another admin, or the public
 * runtime, changed one of the restored fields afterwards, the undo answers 409
 * `forms.errors.undo_conflict` and the newer change is kept. An undo with nothing in between
 * still restores the previous state.
 */

const UNDO_CONFLICT_CODE = 'forms.errors.undo_conflict'
const UNDO_CONFLICT_MESSAGE =
  'This record changed after the action you are undoing. Undo was refused to keep the newer changes.'

async function renameForm(request: APIRequestContext, token: string, formId: string, name: string) {
  const response = await apiRequest(request, 'PATCH', `/api/forms/${formId}`, { token, data: { name } })
  expect(response.status(), `rename to ${name}: ${await response.text()}`).toBe(200)
  return expectOperation(response, `rename to ${name}`)
}

async function readFormName(request: APIRequestContext, token: string, formId: string): Promise<string | undefined> {
  const response = await apiRequest(request, 'GET', `/api/forms/${formId}`, { token })
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ name?: string }>(response))?.name
}

async function expectUndoConflict(request: APIRequestContext, token: string, undoToken: string) {
  const undo = await undoByToken(request, token, undoToken)
  const body = await readJsonSafe<{ error?: string; code?: string }>(undo)
  expect(undo.status(), `stale undo body ${JSON.stringify(body)}`).toBe(409)
  expect(body?.code).toBe(UNDO_CONFLICT_CODE)
  expect(body?.error).toBe(UNDO_CONFLICT_MESSAGE)
}

test.describe('TC-FORMS-LOCK-002: forms undo refuses a stale snapshot', () => {
  test.beforeEach(() => {
    skipIfUndoTestsDisabled()
  })

  test('undo of an older rename keeps a newer rename by another admin', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const otherToken = await getAuthToken(request, 'superadmin')
    let formId: string | null = null
    try {
      formId = (await createFormFixture(request, adminToken, { name: 'QA LOCK002 Draft Intake' })).id
      const adminRename = await renameForm(request, adminToken, formId, 'QA LOCK002 Patient Intake')
      await renameForm(request, otherToken, formId, 'QA LOCK002 Patient Intake (Spanish)')

      await expectUndoConflict(request, adminToken, adminRename.undoToken)
      expect(await readFormName(request, adminToken, formId)).toBe('QA LOCK002 Patient Intake (Spanish)')
    } finally {
      await deleteFormIfExists(request, adminToken, formId)
    }
  })

  test('undo of a rename with nothing in between still restores the previous name', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    let formId: string | null = null
    try {
      formId = (await createFormFixture(request, adminToken, { name: 'QA LOCK002 Original' })).id
      const rename = await renameForm(request, adminToken, formId, 'QA LOCK002 Renamed')

      await undoOk(request, adminToken, rename.undoToken, 'own rename')
      expect(await readFormName(request, adminToken, formId)).toBe('QA LOCK002 Original')
    } finally {
      await deleteFormIfExists(request, adminToken, formId)
    }
  })

  test('undo of a close keeps a distribution another admin reopened', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const otherToken = await getAuthToken(request, 'superadmin')
    let formId: string | null = null
    let distributionId: string | null = null
    try {
      formId = (await createFormFixture(request, adminToken)).id
      distributionId = (await createDistributionFixture(request, adminToken, formId, { maxResponses: 10 })).id

      const close = await patchDistribution(request, adminToken, distributionId, { status: 'closed' })
      expect(close.status(), await close.text()).toBe(200)
      const closeOperation = expectOperation(close, 'close distribution')
      const reopen = await patchDistribution(request, otherToken, distributionId, { status: 'active', maxResponses: 50 })
      expect(reopen.status(), await reopen.text()).toBe(200)

      await expectUndoConflict(request, adminToken, closeOperation.undoToken)
      const current = await readDistribution(request, adminToken, distributionId)
      expect(current).toEqual(expect.objectContaining({ status: 'active', maxResponses: 50 }))
    } finally {
      await deleteDistributionIfExists(request, adminToken, distributionId)
      await deleteFormIfExists(request, adminToken, formId)
    }
  })

  test('undo of a send keeps an invitation the recipient opened afterwards', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`
    let formId: string | null = null
    let distributionId: string | null = null
    try {
      formId = (await createPublishedFormFixture(request, adminToken, { name: `QA LOCK002 ${stamp}` })).formId
      distributionId = (await createDistributionFixture(request, adminToken, formId, { mode: 'personal' })).id
      const [invitation] = await createInvitationsFixture(request, adminToken, distributionId, [
        { email: `qa-lock002-${stamp}@test.local`, name: 'Recipient' },
      ])
      expect(invitation.rawToken).toBeTruthy()

      const send = await apiRequest(
        request,
        'POST',
        `/api/forms/distributions/${distributionId}/invitations/${invitation.id}/send`,
        { token: adminToken },
      )
      expect(send.status(), await send.text()).toBe(200)
      const sendOperation = expectOperation(send, 'send invitation')

      await withCredentialIsolatedRequest(async (anonymous) => {
        const resolved = await anonymous.get(`/api/forms/public/invitations/${invitation.rawToken}`)
        expect(resolved.status(), await resolved.text()).toBe(200)
      })

      await expectUndoConflict(request, adminToken, sendOperation.undoToken)
      const listed = await listInvitations(request, adminToken, distributionId)
      const row = (listed?.items ?? []).find((item) => item.id === invitation.id)
      expect(row?.status).toBe('opened')
    } finally {
      await deleteDistributionIfExists(request, adminToken, distributionId)
      await deleteFormIfExists(request, adminToken, formId)
    }
  })

  test('the undo banner shows the conflict when another admin renamed the form since', async ({ page, request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const otherToken = await getAuthToken(request, 'superadmin')
    let formId: string | null = null
    try {
      formId = (await createFormFixture(request, adminToken, { name: 'QA LOCK002 UI Original' })).id

      await login(page, 'admin')
      await page.goto(`/backend/forms/${formId}`)
      await page.getByRole('tab', { name: 'Configuration' }).click()
      const nameInput = page.locator('#forms-studio-form-name')
      await expect(nameInput).toHaveValue('QA LOCK002 UI Original', { timeout: 30_000 })
      const saved = page.waitForResponse(
        (response) => response.url().endsWith(`/api/forms/${formId}`) && response.request().method() === 'PATCH',
      )
      await nameInput.fill('QA LOCK002 UI Admin')
      expect((await saved).status()).toBe(200)
      await renameForm(request, otherToken, formId, 'QA LOCK002 UI Other')

      const undoButton = page.getByRole('button', { name: 'Undo', exact: true })
      await expect(undoButton).toBeVisible({ timeout: 5_000 })
      await undoButton.click()

      await expect(page.getByText(UNDO_CONFLICT_MESSAGE).first()).toBeVisible({ timeout: 15_000 })
      expect(await readFormName(request, adminToken, formId)).toBe('QA LOCK002 UI Other')
    } finally {
      await deleteFormIfExists(request, adminToken, formId)
    }
  })
})
