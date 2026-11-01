import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/helpers/integration/api';
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures';
import { resolveIntegrationDatabaseUrl, withClient } from '@open-mercato/core/helpers/integration/dbFixtures';
import { expectOperation, skipIfUndoTestsDisabled, undoOk } from '@open-mercato/core/helpers/integration/undoHarness';
import { createCodeFixture, deleteCodeIfExists, CODES_PATH, CODES_USE_PATH, uniqueStamp } from './helpers';

/**
 * TC-PROM-085: a generated voucher redeemed while a code delete is in flight must stay
 * inactive after that delete is undone. A raw Postgres transaction stands in for
 * `codes/use` (same statement order: lock the code row, lock and deactivate the generated
 * code, insert the usage row) so the delete request can be observed waiting on its lock
 * before the redemption commits.
 */
test.describe('TC-PROM-085: code delete undo keeps a voucher redeemed during the delete inactive', () => {
  test('undo restores the code and its unused vouchers but not the voucher redeemed during the delete', async ({ request }) => {
    skipIfUndoTestsDisabled();
    test.setTimeout(90_000);
    const token = await getAuthToken(request, 'admin');
    const stamp = uniqueStamp();
    const voucherCode = `QA085V${stamp}`.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const siblingCode = `QA085S${stamp}`.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const voucherId = randomUUID();
    const siblingId = randomUUID();
    let codeId: string | null = null;
    const redeemer = new Client({ connectionString: resolveIntegrationDatabaseUrl() });
    let redeemerOpen = false;

    try {
      const fixture = await createCodeFixture(request, token, {
        name: `QA PROM 085 ${stamp}`,
        type: 'dynamic',
        amount: 1,
        usage: 'unlimited',
        active: true,
      });
      codeId = fixture.id;

      const scope = await withClient(async (client) => {
        const result = await client.query<{ organization_id: string; tenant_id: string }>(
          'select organization_id, tenant_id from promotion_codes where id = $1',
          [codeId],
        );
        return result.rows[0];
      });
      expect(scope, 'the created code row must exist').toBeTruthy();
      await withClient(async (client) => {
        await client.query(
          `insert into promotion_generated_codes (id, code_id, organization_id, tenant_id, code, active, created_at, updated_at)
           values ($1, $3, $4, $5, $6, true, now(), now()), ($2, $3, $4, $5, $7, true, now(), now())`,
          [voucherId, siblingId, codeId, scope.organization_id, scope.tenant_id, voucherCode, siblingCode],
        );
      });

      await redeemer.connect();
      redeemerOpen = true;
      const redeemerPid = (await redeemer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;
      await redeemer.query('begin');
      await redeemer.query('select id from promotion_codes where id = $1 for update', [codeId]);
      await redeemer.query('select id from promotion_generated_codes where id = $1 for update', [voucherId]);
      await redeemer.query('update promotion_generated_codes set active = false where id = $1', [voucherId]);
      await redeemer.query(
        'insert into promotion_code_usages (code_id, customer_id, organization_id, tenant_id, used_at) values ($1, null, $2, $3, now())',
        [codeId, scope.organization_id, scope.tenant_id],
      );

      const deletePromise = apiRequest(request, 'DELETE', `${CODES_PATH}?id=${encodeURIComponent(codeId)}`, { token });

      await expect
        .poll(
          async () =>
            withClient(async (client) => {
              const result = await client.query<{ count: string }>(
                `select count(*)::text as count from pg_stat_activity
                  where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
                [redeemerPid],
              );
              return Number(result.rows[0]?.count ?? '0');
            }),
          { message: 'the delete request must wait on the redemption lock', timeout: 20_000 },
        )
        .toBeGreaterThan(0);

      await redeemer.query('commit');
      const deleteResponse = await deletePromise;
      expect(deleteResponse.status(), 'DELETE /api/promotions/codes should succeed').toBe(200);
      const deleteOperation = expectOperation(deleteResponse, 'promotions code delete');

      await undoOk(request, token, deleteOperation.undoToken, 'promotions code delete');

      const state = await withClient(async (client) => {
        const code = await client.query<{ deleted_at: string | null }>(
          'select deleted_at from promotion_codes where id = $1',
          [codeId],
        );
        const generated = await client.query<{ id: string; active: boolean }>(
          'select id, active from promotion_generated_codes where id = any($1::uuid[])',
          [[voucherId, siblingId]],
        );
        const usages = await client.query<{ count: string }>(
          'select count(*)::text as count from promotion_code_usages where code_id = $1',
          [codeId],
        );
        return {
          deletedAt: code.rows[0]?.deleted_at ?? null,
          active: Object.fromEntries(generated.rows.map((row) => [row.id, row.active])),
          usages: Number(usages.rows[0]?.count ?? '0'),
        };
      });
      expect(state.deletedAt, 'undo restores the code').toBeNull();
      expect(state.active[siblingId], 'undo reactivates the unused voucher the delete deactivated').toBe(true);
      expect(state.active[voucherId], 'the voucher redeemed during the delete must stay inactive').toBe(false);
      expect(state.usages).toBe(1);

      const reuseResponse = await apiRequest(request, 'POST', CODES_USE_PATH, {
        token,
        data: { codeId, codeString: voucherCode, cartId: randomUUID(), customerId: null, type: 'dynamic' },
      });
      expect(reuseResponse.status(), 'the redeemed voucher must not be usable again').toBe(422);
      expect(await readJsonSafe<Record<string, unknown>>(reuseResponse)).toEqual({ error: 'code_invalid' });
    } finally {
      if (redeemerOpen) {
        await redeemer.query('rollback').catch(() => undefined);
        await redeemer.end().catch(() => undefined);
      }
      await deleteCodeIfExists(request, token, codeId);
      if (codeId) {
        const cleanupCodeId = codeId;
        await withClient(async (client) => {
          await client.query('delete from promotion_code_usages where code_id = $1', [cleanupCodeId]);
          await client.query('delete from promotion_generated_codes where code_id = $1', [cleanupCodeId]);
        }).catch(() => undefined);
      }
    }
  });
});
