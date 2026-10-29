import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import {
  apiRequestWithSelectedOrg,
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setUserAclVisibility,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import {
  clearUserHomeOrganization,
  createOrganizationInDb,
  deleteOrganizationInDb,
  deleteUserAclInDb,
  withClient,
} from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'

type RegisterResult = { id: string; deviceId: string; revived: boolean }

const SELF_PATH = '/api/devices'
const ADMIN_PATH = '/api/devices/admin/devices'

async function readDeviceRow(id: string): Promise<{ client_app_version: string | null; deleted_at: Date | null } | null> {
  return withClient(async (client) => {
    const result = await client.query<{ client_app_version: string | null; deleted_at: Date | null }>(
      'select client_app_version, deleted_at from user_devices where id = $1',
      [id],
    )
    return result.rows[0] ?? null
  })
}

test.describe('TC-DEV-011: Device writes stay inside the caller organization scope', () => {
  test('a restricted user cannot update their own device in an organization outside their scope', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenScope(adminToken)

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    const password = 'Restricted1!Owner'
    const restrictedEmail = `tc-dev-011-restricted-${stamp}@acme.com`

    let orgAId: string | null = null
    let orgBId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    let orgADeviceId: string | null = null
    let orgBDeviceId: string | null = null
    try {
      orgAId = await createOrganizationInDb({ name: `TC-DEV-011 Org A ${stamp}`, tenantId })
      orgBId = await createOrganizationInDb({ name: `TC-DEV-011 Org B ${stamp}`, tenantId })

      roleId = await createRoleFixture(request, adminToken, { name: `TC-DEV-011 Role ${stamp}` })
      userId = await createUserFixture(request, adminToken, {
        email: restrictedEmail,
        password,
        organizationId: orgAId,
        roles: [roleId],
      })

      const orgARes = await apiRequestWithSelectedOrg(request, 'POST', ADMIN_PATH, {
        token: adminToken,
        selectedOrgId: orgAId,
        data: { userId, deviceId: `qa-dev11-a-${stamp}`, platform: 'ios', clientAppVersion: '1.0.0' },
      })
      expect(orgARes.status()).toBe(201)
      orgADeviceId = (await readJsonSafe<RegisterResult>(orgARes))?.id ?? null

      const orgBRes = await apiRequestWithSelectedOrg(request, 'POST', ADMIN_PATH, {
        token: adminToken,
        selectedOrgId: orgBId,
        data: { userId, deviceId: `qa-dev11-b-${stamp}`, platform: 'ios', clientAppVersion: '1.0.0' },
      })
      expect(orgBRes.status()).toBe(201)
      orgBDeviceId = (await readJsonSafe<RegisterResult>(orgBRes))?.id ?? null
      expect(orgADeviceId && orgBDeviceId).toBeTruthy()

      await setUserAclVisibility(request, adminToken, {
        userId,
        organizations: [orgAId],
        features: ['devices.manage'],
      })
      await clearUserHomeOrganization(userId)
      const restrictedToken = await getAuthToken(request, restrictedEmail, password)

      const allowed = await apiRequest(request, 'PUT', `${SELF_PATH}/${orgADeviceId}`, {
        token: restrictedToken,
        data: { clientAppVersion: '2.0.0' },
      })
      expect(allowed.status(), 'own device inside the caller scope stays editable').toBe(200)
      expect((await readDeviceRow(orgADeviceId!))?.client_app_version).toBe('2.0.0')

      const deniedUpdate = await apiRequest(request, 'PUT', `${SELF_PATH}/${orgBDeviceId}`, {
        token: restrictedToken,
        data: { clientAppVersion: '9.9.9' },
      })
      expect(deniedUpdate.status(), 'own device outside the caller scope must not be updated').toBe(403)
      expect((await readDeviceRow(orgBDeviceId!))?.client_app_version).toBe('1.0.0')

      const deniedDelete = await apiRequest(request, 'DELETE', `${SELF_PATH}/${orgBDeviceId}`, {
        token: restrictedToken,
      })
      expect(deniedDelete.status(), 'deactivate already enforces the same organization scope').toBe(403)
      expect((await readDeviceRow(orgBDeviceId!))?.deleted_at).toBeNull()
    } finally {
      for (const id of [orgADeviceId, orgBDeviceId]) {
        if (id) await apiRequest(request, 'DELETE', `${ADMIN_PATH}/${id}`, { token: adminToken }).catch(() => undefined)
      }
      if (userId) await deleteUserAclInDb(userId).catch(() => undefined)
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteOrganizationInDb(orgAId).catch(() => undefined)
      await deleteOrganizationInDb(orgBId).catch(() => undefined)
    }
  })
})
