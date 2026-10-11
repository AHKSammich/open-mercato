import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommunicationChannel } from '../data/entities'
import { emitCommunicationChannelsEvent } from '../events'

/**
 * Subscriber: cascade-disconnect a user's communication channels when the user
 * is deleted (`auth.user.deleted` event).
 *
 * Why a subscriber, not a foreign-key CASCADE: per root `AGENTS.md`, modules
 * don't form direct ORM relationships across the auth module boundary —
 * `CommunicationChannel.userId` is a plain `uuid` column, not a FK. The
 * cascade must therefore happen at the event-bridge layer, here, in response
 * to the auth module's lifecycle event.
 *
 * Scope: the deleted user's id (`payload.id`) within the event's tenant
 * (envelope tenant first, payload tenant as fallback). Channels in every
 * organization of that tenant are matched. Without a tenant the subscriber
 * does nothing (fail closed).
 *
 * Effects per matched channel:
 *   1. `status = 'disconnected'`, `is_active = false`, `is_primary = false`
 *      — stops polling, push-watch renewal and adapter resolution.
 *   2. `credentials_ref = null` — detaches the stored credentials. The
 *      `integration_credentials` row itself is not swept here (known
 *      follow-up).
 *   3. `last_error = 'user-deleted'` — diagnostic breadcrumb.
 *   4. `communication_channels.channel.disconnected` is emitted after the
 *      flush, with the same payload as the user-initiated disconnect.
 *
 * The provider-side watch (e.g. Gmail) is not stopped here; it is no longer
 * renewed because the channel is inactive and expires on its own. The channel
 * row and already ingested mail are retained for the audit trail.
 *
 * Idempotency: channels already disconnected and inactive are skipped, so
 * event-bus replays neither re-flush nor re-emit.
 */
export const metadata = {
  event: 'auth.user.deleted',
  persistent: true,
  id: 'communication_channels:user-deleted-cascade',
}

type AuthUserDeletedPayload = {
  id?: string
  tenantId?: string | null
  organizationId?: string | null
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
  tenantId?: string | null
  organizationId?: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export default async function handler(
  payload: AuthUserDeletedPayload,
  ctx: SubscriberContext,
): Promise<void> {
  const userId = nonEmptyString(payload?.id)
  if (!userId) return
  const tenantId = nonEmptyString(ctx?.tenantId) ?? nonEmptyString(payload?.tenantId)
  if (!tenantId) return
  const em = (ctx.resolve('em') as EntityManager).fork()

  const channels = await findWithDecryption(
    em,
    CommunicationChannel,
    { userId, tenantId, deletedAt: null },
    undefined,
    { tenantId, organizationId: null },
  )
  if (channels.length === 0) return

  const touched: CommunicationChannel[] = []
  for (const channel of channels) {
    if (channel.status === 'disconnected' && channel.isActive === false) continue
    channel.status = 'disconnected'
    channel.isActive = false
    channel.credentialsRef = null
    channel.lastError = 'user-deleted'
    channel.isPrimary = false
    channel.lastPolledAt = new Date()
    touched.push(channel)
  }
  if (touched.length === 0) return
  await em.flush()

  for (const channel of touched) {
    await emitCommunicationChannelsEvent(
      'communication_channels.channel.disconnected',
      {
        channelId: channel.id,
        userId,
        providerKey: channel.providerKey,
        channelType: channel.channelType,
        tenantId: channel.tenantId,
        organizationId: channel.organizationId ?? null,
      },
      { persistent: true },
    )
  }
}
