import { expect, test } from '@playwright/test'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  apiRequest,
  createSsoConfigFixture,
  createScimTokenFixture,
  addDomainFixture,
  activateConfigFixture,
  getAuthToken,
  scimRequest,
} from '../helpers/ssoFixtures'

/**
 * TC-SSO-007 — deleting a user cleans up that user's SSO identities and role grants.
 *
 * `DELETE /api/auth/users` emits `auth.user.deleted` with `{ id, organizationId, tenantId }`.
 * The `sso:user-deleted-cleanup` subscriber must soft-delete the user's identities and remove
 * its role grants — including rows written with a NULL tenant (tenantless SSO configs) — while
 * another SCIM user's identity stays active. The user-visible symptom on develop: the IdP could
 * not re-provision the same `externalId` after the platform user was deleted (unique conflict).
 */

type IdentityRow = { id: string; user_id: string; tenant_id: string | null; organization_id: string; deleted_at: string | null }

async function identityUserId(identityId: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ user_id: string }>('select user_id from sso_identities where id = $1', [identityId])
    const userId = result.rows[0]?.user_id
    expect(userId, `identity ${identityId} has a user`).toBeTruthy()
    return userId as string
  })
}

async function identitiesOf(userId: string): Promise<IdentityRow[]> {
  return withClient(async (client) => {
    const result = await client.query<IdentityRow>(
      'select id, user_id, tenant_id, organization_id, deleted_at from sso_identities where user_id = $1',
      [userId],
    )
    return result.rows
  })
}

async function roleGrantCount(userId: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ count: string }>('select count(*)::text as count from sso_role_grants where user_id = $1', [userId])
    return Number(result.rows[0]?.count ?? '0')
  })
}

test.describe('TC-SSO-007: user deletion cleans up SSO identities and role grants', () => {
  test('deleting a SCIM-provisioned user cleans its SSO rows and lets the IdP re-provision it', async ({ request }) => {
    test.slow()
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const { configId, cleanup: cleanupConfig } = await createSsoConfigFixture(request, token, {
      jitEnabled: false,
      issuer: 'https://accounts.google.com',
    })
    const { rawToken, cleanup: cleanupToken } = await createScimTokenFixture(request, token, configId)
    await addDomainFixture(request, token, configId, `scim-007-${stamp}.example.com`)
    await activateConfigFixture(request, token, configId)

    const userIds: string[] = []
    const scimUser = (suffix: string) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: `scim-007-${suffix}-${stamp}@scim-007-${stamp}.example.com`,
      displayName: `SCIM 007 ${suffix}`,
      name: { givenName: 'SCIM', familyName: suffix },
      emails: [{ value: `scim-007-${suffix}-${stamp}@scim-007-${stamp}.example.com`, type: 'work', primary: true }],
      active: true,
      externalId: `ext-007-${suffix}-${stamp}`,
    })

    try {
      const createDeleted = await scimRequest(request, 'POST', '/api/sso/scim/v2/Users', rawToken, scimUser('deleted'))
      expect(createDeleted.status(), 'SCIM create (user to delete) returns 201').toBe(201)
      const deletedUserId = await identityUserId(((await createDeleted.json()) as { id: string }).id)
      userIds.push(deletedUserId)

      const createKept = await scimRequest(request, 'POST', '/api/sso/scim/v2/Users', rawToken, scimUser('kept'))
      expect(createKept.status(), 'SCIM create (control user) returns 201').toBe(201)
      const keptUserId = await identityUserId(((await createKept.json()) as { id: string }).id)
      userIds.push(keptUserId)

      const [scimIdentity] = await identitiesOf(deletedUserId)
      expect(scimIdentity, 'the SCIM user has an identity').toBeTruthy()
      await withClient(async (client) => {
        await client.query('update sso_identities set tenant_id = null where id = $1', [scimIdentity.id])
        await client.query(
          `insert into sso_role_grants (tenant_id, organization_id, user_id, role_id, sso_config_id, created_at)
           values ($1, $5, $2, gen_random_uuid(), $3, now()), (null, $5, $2, gen_random_uuid(), $3, now()), ($1, $5, $4, gen_random_uuid(), $3, now())`,
          [scimIdentity.tenant_id, deletedUserId, configId, keptUserId, scimIdentity.organization_id],
        )
      })
      const liveBefore = (await identitiesOf(deletedUserId)).filter((row) => !row.deleted_at)
      expect(liveBefore.map((row) => row.tenant_id), 'one live NULL-tenant identity before delete').toEqual([null])
      expect(await roleGrantCount(deletedUserId), 'two role grants before delete').toBe(2)

      const deleteResponse = await apiRequest(request, 'DELETE', `/api/auth/users?id=${encodeURIComponent(deletedUserId)}`, { token })
      expect(deleteResponse.status(), 'DELETE /api/auth/users returns 200').toBe(200)

      await expect
        .poll(async () => (await identitiesOf(deletedUserId)).filter((row) => !row.deleted_at).length, {
          message: 'every identity of the deleted user is soft-deleted, including the NULL-tenant one',
          timeout: 20_000,
        })
        .toBe(0)
      await expect
        .poll(async () => roleGrantCount(deletedUserId), {
          message: 'every role grant of the deleted user is removed, including the NULL-tenant one',
          timeout: 20_000,
        })
        .toBe(0)

      expect((await identitiesOf(keptUserId)).filter((row) => !row.deleted_at), 'the control user keeps its identity').toHaveLength(1)
      expect(await roleGrantCount(keptUserId), 'the control user keeps its role grant').toBe(1)

      const reprovision = await scimRequest(request, 'POST', '/api/sso/scim/v2/Users', rawToken, scimUser('deleted'))
      expect(reprovision.status(), 'the IdP can re-provision the same externalId').toBe(201)
      userIds.push(await identityUserId(((await reprovision.json()) as { id: string }).id))
    } finally {
      for (const userId of userIds) {
        await apiRequest(request, 'DELETE', `/api/auth/users?id=${encodeURIComponent(userId)}`, { token }).catch(() => undefined)
      }
      await withClient(async (client) => {
        await client.query('delete from sso_role_grants where sso_config_id = $1', [configId])
        await client.query('delete from sso_user_deactivations where user_id = any($1::uuid[])', [userIds])
        await client.query('delete from sso_identities where sso_config_id = $1', [configId])
      }).catch(() => undefined)
      await cleanupToken()
      await cleanupConfig()
    }
  })
})
