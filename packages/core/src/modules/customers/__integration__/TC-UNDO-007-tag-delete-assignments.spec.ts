import { expect, test, type APIRequestContext } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createCompanyFixture,
  createPersonFixture,
  deleteEntityIfExists,
} from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  expectOperation,
  undoOk,
  redoOk,
  skipIfUndoTestsDisabled,
} from '@open-mercato/core/helpers/integration/undoHarness'

/**
 * TC-UNDO-007 customers.tags delete undo restores the tag's assignments.
 *
 * Deleting a tag removes every customer assignment of that tag. Undoing the delete must bring
 * the tag back on each customer that carried it, a redo must remove them again, and undoing the
 * redo must restore them once more. Membership is read through the people/companies lists
 * filtered by the tag (a unique `probe` query param keeps every read out of the list cache),
 * and the cached person/company detail `tags` arrays must follow the delete and its undo.
 * Self-contained: the tag, person and company are created via API and removed in teardown.
 */

const TAGS = '/api/customers/tags'
const ASSIGN = '/api/customers/tags/assign'
const PEOPLE = '/api/customers/people'
const COMPANIES = '/api/customers/companies'

type Fixture = { token: string; personId: string; companyId: string; tagId: string }

let probe = 0

async function listedWithTag(request: APIRequestContext, token: string, path: string, entityId: string, tagId: string): Promise<boolean> {
  probe += 1
  const query = `tagIds=${encodeURIComponent(tagId)}&pageSize=100&probe=${Date.now()}-${probe}`
  const res = await apiRequest(request, 'GET', `${path}?${query}`, { token })
  expect(res.ok(), `GET ${path} status ${res.status()}`).toBeTruthy()
  const body = (await readJsonSafe(res)) as { items?: Array<{ id: string }> } | null
  return Boolean(body?.items?.some((item) => item.id === entityId))
}

async function detailHasTag(request: APIRequestContext, token: string, path: string, entityId: string, tagId: string): Promise<boolean> {
  const res = await apiRequest(request, 'GET', `${path}/${encodeURIComponent(entityId)}`, { token })
  expect(res.ok(), `GET ${path}/${entityId} status ${res.status()}`).toBeTruthy()
  const body = (await readJsonSafe(res)) as { tags?: Array<{ id: string }> } | null
  return Boolean(body?.tags?.some((tag) => tag.id === tagId))
}

async function membership(request: APIRequestContext, fixture: Fixture) {
  return {
    person: await listedWithTag(request, fixture.token, PEOPLE, fixture.personId, fixture.tagId),
    company: await listedWithTag(request, fixture.token, COMPANIES, fixture.companyId, fixture.tagId),
  }
}

async function detailMembership(request: APIRequestContext, fixture: Fixture) {
  return {
    person: await detailHasTag(request, fixture.token, PEOPLE, fixture.personId, fixture.tagId),
    company: await detailHasTag(request, fixture.token, COMPANIES, fixture.companyId, fixture.tagId),
  }
}

async function withTaggedCustomers(
  request: APIRequestContext,
  label: string,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const token = await getAuthToken(request, 'admin')
  const stamp = `${Date.now()}-${label}`
  let personId: string | null = null
  let companyId: string | null = null
  let tagId: string | null = null
  try {
    companyId = await createCompanyFixture(request, token, `Undo TagDelete Co ${stamp}`)
    personId = await createPersonFixture(request, token, {
      firstName: 'Undo',
      lastName: `TagDelete ${stamp}`,
      displayName: `Undo TagDelete ${stamp}`,
    })
    const tagRes = await apiRequest(request, 'POST', TAGS, {
      token,
      data: { slug: `undo-tag-delete-${stamp}`, label: `Undo Tag Delete ${stamp}` },
    })
    expect(tagRes.status(), `tag create status ${tagRes.status()}`).toBe(201)
    tagId = expectOperation(tagRes, 'tags.create').resourceId
    expect(tagId, 'tag id present').toBeTruthy()
    for (const entityId of [personId, companyId]) {
      const assignRes = await apiRequest(request, 'POST', ASSIGN, { token, data: { tagId, entityId } })
      expect(assignRes.status(), `assign status ${assignRes.status()}`).toBe(201)
    }
    await run({ token, personId, companyId, tagId: tagId as string })
  } finally {
    await deleteEntityIfExists(request, token, TAGS, tagId)
    await deleteEntityIfExists(request, token, PEOPLE, personId)
    await deleteEntityIfExists(request, token, COMPANIES, companyId)
  }
}

async function deleteTag(request: APIRequestContext, fixture: Fixture) {
  const res = await apiRequest(request, 'DELETE', `${TAGS}?id=${encodeURIComponent(fixture.tagId)}`, { token: fixture.token })
  expect(res.ok(), `tag delete status ${res.status()}`).toBeTruthy()
  return expectOperation(res, 'tags.delete')
}

test.describe('TC-UNDO-007 customers.tags delete undo restores assignments', () => {
  test.beforeAll(() => {
    skipIfUndoTestsDisabled()
  })

  test('delete → undo restores assignments → redo removes → undo restores again', async ({ request }) => {
    await withTaggedCustomers(request, 'membership', async (fixture) => {
      expect(await membership(request, fixture), 'assigned before delete').toEqual({ person: true, company: true })

      const deleteOp = await deleteTag(request, fixture)
      expect(await membership(request, fixture), 'assignments removed by delete').toEqual({ person: false, company: false })

      await undoOk(request, fixture.token, deleteOp.undoToken, 'undo tag delete')
      expect(await membership(request, fixture), 'assignments restored on undo').toEqual({ person: true, company: true })

      const redo = await redoOk(request, fixture.token, deleteOp.logId, 'redo tag delete')
      expect(await membership(request, fixture), 'assignments removed again on redo').toEqual({ person: false, company: false })
      expect(redo.undoToken, 'redo issues an undo token').toBeTruthy()

      await undoOk(request, fixture.token, redo.undoToken as string, 'undo tag delete redo')
      expect(await membership(request, fixture), 'assignments restored on undo of redo').toEqual({ person: true, company: true })
    })
  })

  test('person and company detail follow the tag delete and its undo', async ({ request }) => {
    await withTaggedCustomers(request, 'detail', async (fixture) => {
      expect(await detailMembership(request, fixture), 'detail lists the tag before delete').toEqual({ person: true, company: true })

      const deleteOp = await deleteTag(request, fixture)
      expect(await detailMembership(request, fixture), 'detail drops the tag after delete').toEqual({ person: false, company: false })

      await undoOk(request, fixture.token, deleteOp.undoToken, 'undo tag delete')
      expect(await detailMembership(request, fixture), 'detail lists the tag again after undo').toEqual({ person: true, company: true })
    })
  })
})
