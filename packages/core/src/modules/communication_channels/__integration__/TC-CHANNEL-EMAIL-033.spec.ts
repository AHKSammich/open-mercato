import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  isChannelSeedingAvailable,
  seedConnectedChannel,
} from '@open-mercato/core/helpers/integration/communicationChannelsFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'

/**
 * TC-CHANNEL-EMAIL-033 — deleting a user disconnects that user's channels and nobody else's.
 *
 * `DELETE /api/auth/users` emits `auth.user.deleted` with `{ id, organizationId, tenantId }`;
 * the `user-deleted-cascade` subscriber must disconnect every channel the user owns
 * (status `disconnected`, inactive, not primary, credentials reference cleared) so polling
 * and watch renewal stop, while a channel owned by another user of the same tenant stays
 * connected. Channels are seeded through the env-gated test-seed fixture
 * (`OM_ENABLE_TEST_CHANNEL_SEEDING`); the spec skips when the gate is off.
 */

type ChannelRow = {
  status: string
  is_active: boolean
  is_primary: boolean
  credentials_ref: string | null
  last_error: string | null
}

async function readChannel(channelId: string): Promise<ChannelRow | null> {
  return withClient(async (client) => {
    const result = await client.query<ChannelRow>(
      'select status, is_active, is_primary, credentials_ref, last_error from communication_channels where id = $1',
      [channelId],
    )
    return result.rows[0] ?? null
  })
}

async function removeChannelRows(channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return
  await withClient(async (client) => {
    await client.query('delete from communication_channels where id = any($1::uuid[])', [channelIds])
  })
}

test.describe('TC-CHANNEL-EMAIL-033: user deletion cascade-disconnects only that user\'s channels', () => {
  test('deleting a user disconnects its channels and leaves another user\'s channel connected', async ({ request }) => {
    test.slow()
    const stamp = Date.now()
    const password = 'Valid1!Pass'
    let adminToken: string | null = null
    let roleId: string | null = null
    let deletedUserId: string | null = null
    let keptUserId: string | null = null
    const channelIds: string[] = []
    try {
      adminToken = await getAuthToken(request, 'admin')
      const seedingAvailable = await isChannelSeedingAvailable(request, adminToken)
      test.skip(
        !seedingAvailable,
        'OM_ENABLE_TEST_CHANNEL_SEEDING is not enabled in this environment; cannot seed connected channels.',
      )

      const scope = getTokenScope(adminToken)
      const roleName = `qa_channel_email_033_${stamp}`
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId: scope.tenantId })
      await setRoleAclFeatures(request, adminToken, {
        roleId,
        features: ['communication_channels.connect_user_channel'],
      })

      const deletedEmail = `qa-channel-email-033-deleted-${stamp}@acme.com`
      deletedUserId = await createUserFixture(request, adminToken, {
        email: deletedEmail,
        password,
        organizationId: scope.organizationId,
        roles: [roleName],
        name: 'QA Channel Email 033 Deleted',
      })
      const keptEmail = `qa-channel-email-033-kept-${stamp}@acme.com`
      keptUserId = await createUserFixture(request, adminToken, {
        email: keptEmail,
        password,
        organizationId: scope.organizationId,
        roles: [roleName],
        name: 'QA Channel Email 033 Kept',
      })

      const deletedToken = await getAuthToken(request, deletedEmail, password)
      const keptToken = await getAuthToken(request, keptEmail, password)
      const ownedA = await seedConnectedChannel(request, deletedToken, { displayName: `EMAIL-033 owned A ${stamp}` })
      const ownedB = await seedConnectedChannel(request, deletedToken, { displayName: `EMAIL-033 owned B ${stamp}` })
      const other = await seedConnectedChannel(request, keptToken, { displayName: `EMAIL-033 other ${stamp}` })
      channelIds.push(ownedA, ownedB, other)

      for (const channelId of channelIds) {
        const before = await readChannel(channelId)
        expect(before?.status, `seeded channel ${channelId} starts connected`).toBe('connected')
        expect(before?.is_active, `seeded channel ${channelId} starts active`).toBe(true)
      }

      const deleteResponse = await apiRequest(
        request,
        'DELETE',
        `/api/auth/users?id=${encodeURIComponent(deletedUserId)}`,
        { token: adminToken },
      )
      expect(deleteResponse.status(), 'DELETE /api/auth/users should return 200').toBe(200)
      deletedUserId = null

      for (const channelId of [ownedA, ownedB]) {
        await expect
          .poll(async () => (await readChannel(channelId))?.status, {
            message: `channel ${channelId} of the deleted user is disconnected`,
            timeout: 20_000,
          })
          .toBe('disconnected')
        const after = await readChannel(channelId)
        expect(after?.is_active, 'disconnected channel is inactive').toBe(false)
        expect(after?.is_primary, 'disconnected channel is not primary').toBe(false)
        expect(after?.credentials_ref, 'credentials reference is cleared').toBeNull()
        expect(after?.last_error, 'disconnect reason is recorded').toBe('user-deleted')
      }

      const untouched = await readChannel(other)
      expect(untouched?.status, 'another user\'s channel stays connected').toBe('connected')
      expect(untouched?.is_active, 'another user\'s channel stays active').toBe(true)
    } finally {
      await removeChannelRows(channelIds).catch(() => undefined)
      await deleteUserIfExists(request, adminToken, deletedUserId)
      await deleteUserIfExists(request, adminToken, keptUserId)
      await deleteRoleIfExists(request, adminToken, roleId)
    }
  })
})
