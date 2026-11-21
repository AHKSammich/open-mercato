import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures';
import {
  CART_CURRENT_PATH,
  CART_LINES_PATH,
  cartStorefrontRequest,
  cleanupCartProductFixture,
  cleanupCartStorefrontFixture,
  createCartProductFixture,
  createCartStorefrontFixture,
  createStorefrontCart,
  deleteCartRowIfExists,
  uniqueStamp,
  type CartProductFixture,
  type CartStorefrontFixture,
} from './helpers';

type CartLineView = { id: string; productId: string; unitPriceNet: string | null; unitPriceGross: string | null };
type CartEnvelope = { cart: { lines: CartLineView[] } };

async function makeGrossOnlyAtFullRebate(priceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `update catalog_product_variant_prices set unit_price_net = null, unit_price_gross = 12, tax_rate = -100, updated_at = now() where id = $1`,
      [priceId],
    );
  });
}

async function readCartLineTaxRate(lineId: string): Promise<string | null | undefined> {
  return withClient(async (client) => {
    const result = await client.query<{ tax_rate: string | null }>(`select tax_rate::text as tax_rate from cart_lines where id = $1`, [lineId]);
    return (result as unknown as { rows: Array<{ tax_rate: string | null }> }).rows[0]?.tax_rate;
  });
}

/**
 * TC-CART-PRICE-09: a catalog price row that carries only its gross side (written outside the
 * catalog price commands, which always store both) with a tax rate of -100% leaves no positive
 * factor to derive the net side from. The cart prices the line at the known gross with no tax
 * rate, the same as when no rate resolves, instead of failing every cart request with a 500.
 */
test.describe('TC-CART-PRICE-09: one-sided price with a non-positive tax factor', () => {
  test.describe.configure({ timeout: 120_000 });

  test('adds and reads the line at the known gross instead of failing with a 500', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    let store: CartStorefrontFixture | null = null;
    let product: CartProductFixture | null = null;
    let cartId: string | null = null;
    try {
      store = await createCartStorefrontFixture(request, token, {});
      product = await createCartProductFixture(request, token, {
        stamp: uniqueStamp(),
        label: 'taxfactor',
        salesChannelId: store.salesChannelId,
      });
      await makeGrossOnlyAtFullRebate(product.priceId);

      const cart = await createStorefrontCart(store.hostname);
      cartId = cart.cartId;
      const added = await cartStorefrontRequest(store.hostname, CART_LINES_PATH, {
        method: 'POST',
        cartToken: cart.token,
        body: { productId: product.productId, quantity: '1' },
      });
      expect(added.status, added.text).toBe(201);
      const addedLine = (added.body as CartEnvelope).cart.lines.find((line) => line.productId === product?.productId);
      expect(addedLine).toBeDefined();
      expect(Number(addedLine?.unitPriceGross)).toBe(12);
      expect(addedLine?.unitPriceNet).toBeNull();
      expect(await readCartLineTaxRate(addedLine?.id ?? '')).toBeNull();

      const current = await cartStorefrontRequest(store.hostname, CART_CURRENT_PATH, { method: 'GET', cartToken: cart.token });
      expect(current.status, current.text).toBe(200);
      const [line] = (current.body as CartEnvelope).cart.lines;
      expect(Number(line.unitPriceGross)).toBe(12);
    } finally {
      if (cartId) await deleteCartRowIfExists(cartId);
      await cleanupCartProductFixture(request, token, product);
      await cleanupCartStorefrontFixture(request, token, store);
    }
  });
});
