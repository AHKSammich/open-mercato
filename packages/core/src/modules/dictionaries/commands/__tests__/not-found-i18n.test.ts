jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (key: string, fallback?: string) => `translated:${key}|${fallback}`,
  })),
}))

import { commandRegistry, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import '@open-mercato/core/modules/dictionaries/commands/entry-operations'
import '@open-mercato/core/modules/dictionaries/commands/entries'

const mockedFindOne = findOneWithDecryption as jest.MockedFunction<typeof findOneWithDecryption>

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const ORG_ID = '33333333-3333-4333-8333-333333333333'
const DICTIONARY_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '44444444-4444-4444-8444-444444444444'

const emFindOne = jest.fn()
const em = { fork: () => em, findOne: emFindOne }

function buildCtx(): CommandRuntimeContext {
  return {
    container: { resolve: (key: string) => (key === 'em' ? em : undefined) } as CommandRuntimeContext['container'],
    auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID, isSuperAdmin: true } as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: ORG_ID,
    organizationIds: null,
  }
}

async function captureError(commandId: string, input: Record<string, unknown>): Promise<unknown> {
  const handler = commandRegistry.get(commandId)
  expect(handler).toBeTruthy()
  try {
    await handler!.execute(input, buildCtx())
  } catch (err) {
    return err
  }
  throw new Error(`[internal] ${commandId} did not throw`)
}

const ENTRY_NOT_FOUND = ['dictionaries.errors.entry_not_found', 'Dictionary entry not found'] as const
const DICTIONARY_NOT_FOUND = ['dictionaries.errors.not_found', 'Dictionary not found'] as const

function expectTranslated404(err: unknown, [key, fallback]: readonly [string, string]) {
  expect(isCrudHttpError(err)).toBe(true)
  if (!isCrudHttpError(err)) return
  expect(err.status).toBe(404)
  expect(err.body).toEqual({ error: `translated:${key}|${fallback}` })
}

const scopedInput = { dictionaryId: DICTIONARY_ID, tenantId: TENANT_ID, organizationId: ORG_ID }

describe('dictionary entry commands answer not-found errors in the request language', () => {
  beforeEach(() => {
    mockedFindOne.mockReset()
    emFindOne.mockReset()
  })

  it('set_default translates a missing entry', async () => {
    mockedFindOne.mockResolvedValueOnce({ id: DICTIONARY_ID } as never).mockResolvedValueOnce(null)
    const err = await captureError('dictionaries.entries.set_default', { ...scopedInput, entryId: ENTRY_ID })
    expectTranslated404(err, ENTRY_NOT_FOUND)
  })

  it('set_default translates a missing dictionary', async () => {
    mockedFindOne.mockResolvedValueOnce(null)
    const err = await captureError('dictionaries.entries.set_default', { ...scopedInput, entryId: ENTRY_ID })
    expectTranslated404(err, DICTIONARY_NOT_FOUND)
  })

  it('reorder translates a missing dictionary', async () => {
    mockedFindOne.mockResolvedValueOnce(null)
    const err = await captureError('dictionaries.entries.reorder', {
      ...scopedInput,
      entries: [{ id: ENTRY_ID, position: 0 }],
    })
    expectTranslated404(err, DICTIONARY_NOT_FOUND)
  })

  it('create translates a missing dictionary', async () => {
    emFindOne.mockResolvedValueOnce(null)
    const err = await captureError('dictionaries.entries.create', { dictionaryId: DICTIONARY_ID, value: 'alpha' })
    expectTranslated404(err, DICTIONARY_NOT_FOUND)
  })

  it('update translates a missing entry', async () => {
    mockedFindOne.mockResolvedValueOnce(null)
    const err = await captureError('dictionaries.entries.update', { id: ENTRY_ID, label: 'Alpha' })
    expectTranslated404(err, ENTRY_NOT_FOUND)
  })

  it('delete translates an entry whose dictionary was deleted', async () => {
    mockedFindOne.mockResolvedValueOnce({
      id: ENTRY_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      dictionary: { id: DICTIONARY_ID, deletedAt: new Date() },
    } as never)
    const err = await captureError('dictionaries.entries.delete', { id: ENTRY_ID })
    expectTranslated404(err, DICTIONARY_NOT_FOUND)
  })
})
