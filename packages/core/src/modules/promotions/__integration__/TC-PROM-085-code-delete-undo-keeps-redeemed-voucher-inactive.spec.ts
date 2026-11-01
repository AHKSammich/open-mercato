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
 * inactive after that delete is undone. A raw Postgres session holds the voucher's row
 * lock so a real `POST /api/promotions/codes/use` can be observed holding the code row
 * lock while it waits; the `DELETE` request is then observed waiting behind that
 * redemption before the voucher lock is released and both requests complete.
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
    const pendingRequests: Array<ReturnType<typeof apiRequest>> = [];

    try {
      const fixture = await createCodeFixture(request, token, {
        name: `QA PROM 085 ${stamp}`,
        type: 'dynamic',
        amount: 1,
        usage: 'unlimited',
        active: true,
      });
      codeId = fixture.id;

      await expect
        .poll(
          async () =>
            withClient(async (client) => {
              const result = await client.query<{ count: string }>(
                'select count(*)::text as count from promotion_generated_codes where code_id = $1',
                [codeId],
              );
              return Number(result.rows[0]?.count ?? '0');
            }),
          { message: 'the generation job queued by the create must finish before the race starts', timeout: 30_000 },
        )
        .toBe(1);

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
      await redeemer.query('select id from promotion_generated_codes where id = $1 for update', [voucherId]);

      const waitingOn = (blockerPid: number) =>
        withClient(async (client) => {
          const result = await client.query<{ pid: number }>(
            `select pid from pg_stat_activity
              where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
            [blockerPid],
          );
          return result.rows.map((row) => row.pid);
        });

      const usePromise = apiRequest(request, 'POST', CODES_USE_PATH, {
        token,
        data: { codeId, codeString: voucherCode, cartId: randomUUID(), customerId: null, type: 'dynamic' },
      });
      pendingRequests.push(usePromise);
      let usePid = 0;
      await expect
        .poll(
          async () => {
            usePid = (await waitingOn(redeemerPid))[0] ?? 0;
            return usePid;
          },
          { message: 'codes/use must hold the code row lock while it waits on the voucher row', timeout: 20_000 },
        )
        .toBeGreaterThan(0);

      const deletePromise = apiRequest(request, 'DELETE', `${CODES_PATH}?id=${encodeURIComponent(codeId)}`, { token });
      pendingRequests.push(deletePromise);
      await expect
        .poll(async () => (await waitingOn(usePid)).length, {
          message: 'the delete request must wait on the redemption',
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      await redeemer.query('rollback');
      const useResponse = await usePromise;
      expect(useResponse.status(), 'the redemption should succeed').toBe(200);
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
      await Promise.allSettled(pendingRequests);
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
