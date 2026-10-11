import type { EntityData } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { SsoIdentity, SsoRoleGrant } from '../data/entities'

export const metadata = {
  event: 'auth.user.deleted',
  persistent: true,
  id: 'sso:user-deleted-cleanup',
}

type UserDeletedPayload = {
  id?: string
  tenantId?: string | null
  organizationId?: string | null
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
  tenantId?: string | null
  organizationId?: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export default async function handle(payload: UserDeletedPayload, ctx: ResolverContext) {
  const userId = nonEmptyString(payload?.id)
  if (!userId) return
  const tenantId = nonEmptyString(ctx?.tenantId) ?? nonEmptyString(payload?.tenantId)
  if (!tenantId) return

  const scope = { userId, $or: [{ tenantId }, { tenantId: null }] }
  const em = ctx.resolve<EntityManager>('em').fork()

  await em.transactional(async (txEm) => {
    await txEm.nativeUpdate(
      SsoIdentity,
      { ...scope, deletedAt: null },
      { deletedAt: new Date() } as EntityData<SsoIdentity>,
    )

    await txEm.nativeDelete(SsoRoleGrant, scope)
  })
}
