import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteGeneralEntityIfExists, expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

type ListCase = {
  name: string
  path: string
  field: string
  payload: (value: string) => Record<string, unknown>
}

const cases: ListCase[] = [
  {
    name: 'ORM list (tags)',
    path: '/api/resources/tags',
    field: 'label',
    payload: (value) => ({ label: value }),
  },
  {
    name: 'query engine list (resource types)',
    path: '/api/resources/resource-types',
    field: 'name',
    payload: (value) => ({ name: value }),
  },
]

async function createRecord(request: APIRequestContext, token: string, listCase: ListCase, value: string): Promise<string> {
  const response = await apiRequest(request, 'POST', listCase.path, { token, data: listCase.payload(value) })
  expect(response.status()).toBe(201)
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, `${listCase.name} creation should return an ID`)
}

for (const listCase of cases) {
  test(`TC-RESO-013: v2 tree advanced filter narrows the ${listCase.name}`, async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = randomUUID()
    const targetValue = `QA v2 filter target ${stamp}`
    const otherValue = `QA v2 filter other ${stamp}`
    const createdIds: string[] = []

    try {
      const targetId = await createRecord(request, token, listCase, targetValue)
      createdIds.push(targetId)
      createdIds.push(await createRecord(request, token, listCase, otherValue))

      const unfiltered = await apiRequest(request, 'GET', `${listCase.path}?${new URLSearchParams({ search: stamp })}`, { token })
      expect(unfiltered.status()).toBe(200)
      expect((await readJsonSafe<{ items: Array<{ id: string }> }>(unfiltered))?.items.map(({ id }) => id).sort())
        .toEqual([...createdIds].sort())

      const params = new URLSearchParams({
        search: stamp,
        'filter[v]': '2',
        'filter[root][combinator]': 'and',
        'filter[root][children][0][type]': 'rule',
        'filter[root][children][0][field]': listCase.field,
        'filter[root][children][0][op]': 'is',
        'filter[root][children][0][value]': targetValue,
      })
      const filtered = await apiRequest(request, 'GET', `${listCase.path}?${params}`, { token })
      expect(filtered.status()).toBe(200)
      expect((await readJsonSafe<{ items: Array<{ id: string }> }>(filtered))?.items.map(({ id }) => id))
        .toEqual([targetId])
    } finally {
      for (const id of createdIds) {
        await deleteGeneralEntityIfExists(request, token, listCase.path, id)
      }
    }
  })
}
