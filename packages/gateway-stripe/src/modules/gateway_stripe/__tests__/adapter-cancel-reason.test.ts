import type { GatewayAdapter } from '@open-mercato/shared/modules/payment_gateways/types'
import { resolveStripeClient } from '../lib/client'
import { stripeAdapterV20231016 } from '../lib/adapters/v2023-10-16'
import { stripeAdapterV20241218 } from '../lib/adapters/v2024-12-18'
import { stripeAdapterV20250224Acacia } from '../lib/adapters/v2025-02-24.acacia'

jest.mock('../lib/client', () => ({
  resolveStripeClient: jest.fn(),
}))

const cancel = jest.fn()
const stripe = { paymentIntents: { cancel } }

const adapters: Array<[string, GatewayAdapter, Record<string, string>]> = [
  ['2023-10-16', stripeAdapterV20231016, {}],
  ['2024-12-18', stripeAdapterV20241218, { cancellation_reason: 'requested_by_customer' }],
  ['2025-02-24.acacia', stripeAdapterV20250224Acacia, { cancellation_reason: 'requested_by_customer' }],
]

const forwardedReasons: Array<[string, string]> = [
  ['fraudulent', 'fraudulent'],
  ['fraud', 'fraudulent'],
  ['duplicate', 'duplicate'],
  ['abandoned', 'abandoned'],
  ['requested_by_customer', 'requested_by_customer'],
]

describe.each(adapters)('Stripe adapter %s cancel reason', (_version, adapter, defaultParams) => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveStripeClient as jest.Mock).mockReturnValue(stripe)
    cancel.mockResolvedValue({ status: 'canceled' })
  })

  it.each(forwardedReasons)('sends reason %s to Stripe as cancellation_reason %s', async (reason, expected) => {
    await adapter.cancel({ sessionId: 'pi_1', reason, credentials: { secretKey: 'sk_test' } })

    expect(cancel).toHaveBeenCalledWith('pi_1', { cancellation_reason: expected }, undefined)
  })

  it('keeps the existing payload when no reason is given', async () => {
    await adapter.cancel({ sessionId: 'pi_1', credentials: { secretKey: 'sk_test' } })

    expect(cancel.mock.calls[0][1]).toStrictEqual(defaultParams)
  })

  it('keeps the existing payload for a free-text reason', async () => {
    await adapter.cancel({ sessionId: 'pi_1', reason: 'Customer changed their mind', credentials: { secretKey: 'sk_test' } })

    expect(cancel.mock.calls[0][1]).toStrictEqual(defaultParams)
  })
})
