import { LIMITS } from '@lexmind/core';
import { describe, expect, it } from 'vitest';
import { POST } from './route.ts';

/**
 * A `Request`-shaped stub rather than a real `Request` with a `FormData` body: constructing an
 * actual multipart body from a several-MB `File` and having jsdom's `Request`/`FormData` decode
 * it back out is what a real request needs, and jsdom's implementation of that round trip does
 * not complete in any reasonable time for a payload this size. The route handler only ever calls
 * `request.formData()`, so a stub exposing exactly that is a faithful, fast substitute.
 */
function postForm(form: FormData): Promise<Response> {
  return POST({ formData: () => Promise.resolve(form) } as unknown as Request);
}

describe('POST /api/analyse', () => {
  it('rejects a file over the ingest size limit before parsing it, with a 413', async () => {
    const oversized = new File([new Uint8Array(LIMITS.maxFileBytes + 1)], 'lease.txt', {
      type: 'text/plain',
    });
    const form = new FormData();
    form.set('file', oversized);

    const response = await postForm(form);
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toMatch(/limit/i);
  });

  it('rejects a request with neither pasted text nor a file, with a 400', async () => {
    const response = await postForm(new FormData());
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Paste lease text or choose a file.');
  });

  it('returns a 400, not an unhandled 500, for a request the platform cannot read as form data', async () => {
    const request = {
      formData: () =>
        Promise.reject(
          new TypeError(
            'Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".',
          ),
        ),
    } as unknown as Request;

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('does not crash on a jurisdiction value outside the known set — falls back to auto-detect', async () => {
    // `jurisdiction` arrives as an untyped form field. Before `isJurisdictionId` guarded it, this
    // exact value reached `JURISDICTIONS['not-a-real-jurisdiction']` — `undefined` — and crashed
    // rule evaluation two calls later with a 502, for anyone who sent a value the dropdown never
    // would.
    const form = new FormData();
    form.set('text', 'The tenant shall pay rent monthly and keep the flat clean.');
    form.set('jurisdiction', 'not-a-real-jurisdiction');

    const response = await postForm(form);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.jurisdiction.id).toBe('unknown');
  });
});
