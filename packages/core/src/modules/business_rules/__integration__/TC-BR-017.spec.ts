import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createBusinessRuleFixture,
  deleteBusinessRuleIfExists,
} from '@open-mercato/core/helpers/integration/businessRulesFixtures'
import {
  buildBusinessRulePayload,
  type ExecutionRuleEntry,
  listRuleLogs,
} from './helpers/businessRulesApi'

async function startReceiver(): Promise<{ server: Server; port: number; hits: () => number }> {
  let count = 0
  const server = createServer((_req, res) => {
    count += 1
    res.writeHead(200).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, port, hits: () => count }
}

test.describe('TC-BR-017: CALL_WEBHOOK action goes through the guarded outbound request', () => {
  test('reports a loopback webhook target as a failed action instead of a silent success', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    const entityType = `QaWebhookEntity${stamp}`
    const ruleKey = `TC_BR_017_${stamp}`
    const entityId = crypto.randomUUID()
    const receiver = await startReceiver()
    let ruleId: string | null = null

    try {
      ruleId = await createBusinessRuleFixture(
        request,
        token,
        buildBusinessRulePayload(stamp, {
          ruleId: ruleKey,
          ruleType: 'ACTION',
          entityType,
          successActions: [
            {
              type: 'CALL_WEBHOOK',
              config: {
                url: `http://127.0.0.1:${receiver.port}/hook/{{entityId}}`,
                method: 'POST',
                body: '{"entityId": "{{entityId}}"}',
              },
            },
          ],
        }),
      )

      const response = await apiRequest(request, 'POST', '/api/business_rules/execute', {
        token,
        data: {
          entityType,
          eventType: 'beforeSave',
          entityId,
          data: { status: 'ACTIVE' },
          dryRun: false,
        },
      })
      expect(response.status(), 'rule execution should succeed').toBe(200)
      const body = await readJsonSafe<{ executedRules?: ExecutionRuleEntry[] }>(response)
      const entry = body?.executedRules?.find((item) => item.ruleId === ruleKey)
      expect(entry?.conditionResult).toBe(true)
      expect(entry?.actionsExecuted?.success, 'an undeliverable webhook must not report success').toBe(false)
      const webhookResult = entry?.actionsExecuted?.results?.find((item) => item.type === 'CALL_WEBHOOK')
      expect(webhookResult?.success).toBe(false)
      expect(webhookResult?.error).toMatch(/CALL_WEBHOOK rejected unsafe URL \(reason=private_ip_literal\)/)
      expect(receiver.hits(), 'the SSRF guard must stop the request before it reaches a loopback host').toBe(0)

      const logs = await listRuleLogs(
        request,
        token,
        `?ruleId=${encodeURIComponent(ruleId)}&entityId=${encodeURIComponent(entityId)}`,
      )
      expect(logs.status, 'logs query should succeed').toBe(200)
      const loggedWebhook = logs.items[0]?.outputContext?.actionsExecuted?.find((item) => item.type === 'CALL_WEBHOOK')
      expect(loggedWebhook?.success, 'the execution log must record the failed webhook').toBe(false)
      expect(loggedWebhook?.error).toMatch(/reason=private_ip_literal/)
    } finally {
      await deleteBusinessRuleIfExists(request, token, ruleId)
      await new Promise<void>((resolve) => receiver.server.close(() => resolve()))
    }
  })
})
