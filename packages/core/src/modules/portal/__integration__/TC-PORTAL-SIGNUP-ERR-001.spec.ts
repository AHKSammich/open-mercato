import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * TC-PORTAL-SIGNUP-ERR-001: Portal signup shows translated copy for non-field failures
 *
 * The signup API answers failures with English `error` strings. The signup page used to
 * render that string verbatim, so a German portal showed "Validation failed". The page
 * must show its own translated banner instead.
 */
test.describe('TC-PORTAL-SIGNUP-ERR-001: portal signup error banner is translated', () => {
  test('a validation failure on an unmapped field shows the German generic banner, not the raw API error', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    expect(organizationId, 'admin organization id should be present').toBeTruthy()

    const orgDetailsRes = await apiRequest(
      request,
      'GET',
      `/api/directory/organizations?view=manage&ids=${encodeURIComponent(organizationId)}&tenantId=${encodeURIComponent(tenantId)}`,
      { token: adminToken },
    )
    expect(orgDetailsRes.ok(), 'organization lookup should succeed').toBeTruthy()
    const orgDetailsBody = (await orgDetailsRes.json()) as { items?: Array<{ slug?: string | null }> }
    const orgSlug = orgDetailsBody.items?.[0]?.slug ?? null
    expect(orgSlug, 'organization slug should be returned').toBeTruthy()

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
    await page.context().addCookies([{ name: 'locale', value: 'de', url: baseUrl, sameSite: 'Lax' }])

    let apiStatus: number | null = null
    let apiError: string | null = null
    let apiDetailKeys: string[] = []
    await page.route('**/api/customer_accounts/signup', async (route) => {
      const payload = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      const response = await route.fetch({ postData: JSON.stringify({ ...payload, organizationId: 'not-a-uuid' }) })
      apiStatus = response.status()
      const body = (await response.json()) as { error?: string; details?: Record<string, string[]> }
      apiError = body.error ?? null
      apiDetailKeys = Object.keys(body.details ?? {})
      await route.fulfill({ response })
    })

    await page.goto(`/${orgSlug}/portal/signup`, { waitUntil: 'domcontentloaded' })
    const submitButton = page.locator('form button[type="submit"]')
    await expect(submitButton).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () => submitButton.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber'))),
        { timeout: 15_000 },
      )
      .toBe(true)
    await page.locator('#signup-name').fill('QA Signup Fehler')
    await page.locator('#signup-email').fill(`qa-signup-err-${Date.now()}@test.local`)
    await page.locator('#signup-password').fill('Password123!')
    await submitButton.click()

    await expect(page.getByText('Registrierung fehlgeschlagen. Bitte versuchen Sie es erneut.')).toBeVisible()
    expect(apiStatus).toBe(400)
    expect(apiError).toBe('Validation failed')
    expect(apiDetailKeys).toEqual(['organizationId'])
    await expect(page.getByText('Validation failed')).toHaveCount(0)
    await expect(page.getByText('Registration failed. Please try again.')).toHaveCount(0)
  })
})
