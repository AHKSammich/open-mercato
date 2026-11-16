import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  readJsonSafe,
  deleteEntityByPathIfExists,
} from '@open-mercato/core/helpers/integration/generalFixtures';

/**
 * TC-DICT-012: Setting an unknown entry as the dictionary default answers the 404
 * in the request language.
 *
 * The set-default route only pre-checks the dictionary, so the "entry not found"
 * 404 comes from the set_default command itself and must follow Accept-Language.
 */
test.describe('TC-DICT-012: set-default entry-not-found follows the request locale', () => {
  test('answers the missing-entry 404 in German and English', async ({ request }) => {
    const stamp = Date.now();
    let token: string | null = null;
    let dictionaryId: string | null = null;

    try {
      token = await getAuthToken(request, 'admin');

      const createResponse = await apiRequest(request, 'POST', '/api/dictionaries', {
        token,
        data: { key: `qa_dict_012_${stamp}`, name: 'QA TC-DICT-012' },
      });
      expect(createResponse.status()).toBe(201);
      dictionaryId = (await readJsonSafe<{ id?: string }>(createResponse))?.id ?? null;
      expect(dictionaryId).toBeTruthy();

      const path = `/api/dictionaries/${encodeURIComponent(dictionaryId!)}/entries/set-default`;
      const data = { entryId: randomUUID() };

      const german = await apiRequest(request, 'POST', path, { token, data, headers: { 'Accept-Language': 'de' } });
      expect(german.status()).toBe(404);
      expect((await readJsonSafe<{ error?: unknown }>(german))?.error).toBe('Wörterbucheintrag nicht gefunden');

      const english = await apiRequest(request, 'POST', path, { token, data, headers: { 'Accept-Language': 'en' } });
      expect(english.status()).toBe(404);
      expect((await readJsonSafe<{ error?: unknown }>(english))?.error).toBe('Dictionary entry not found');
    } finally {
      if (token && dictionaryId) {
        await deleteEntityByPathIfExists(request, token, `/api/dictionaries/${encodeURIComponent(dictionaryId)}`);
      }
    }
  });
});
