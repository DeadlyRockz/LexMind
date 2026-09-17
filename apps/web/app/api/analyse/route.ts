/**
 * Dev-only bridge to `packages/core`'s `analyse()` pipeline, for the `/try` scratch page.
 *
 * Not part of the phase 10 deliverable (see `app/page.tsx`) — that owns the real upload flow,
 * accessibility work and design. This exists so the engine can be exercised from a browser before
 * phase 10 lands.
 */

import {
  analyse,
  formatBytes,
  ingestBytes,
  ingestPastedText,
  isIngestError,
  isJurisdictionId,
  isModelError,
  LIMITS,
  segment,
  selectModel,
} from '@lexmind/core';
import { NextResponse } from 'next/server';

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Thrown by the platform, not by anything below, when the request has no body or a
    // Content-Type other than multipart/form-data or application/x-www-form-urlencoded — a
    // malformed request, not a server fault, so it is a 400 rather than an unhandled 500.
    return NextResponse.json(
      { error: 'The request could not be read as form data.' },
      {
        status: 400,
      },
    );
  }

  const file = form.get('file');
  const text = form.get('text');
  const jurisdictionField = form.get('jurisdiction');
  // `isJurisdictionId` is a real runtime check, not a cast: `JurisdictionId` is erased at compile
  // time, so an unchecked `as JurisdictionId` would let any client-supplied string reach
  // `JURISDICTIONS[id]` — a closed lookup that returns `undefined`, not an error, for anything
  // outside the known set, which then throws deep inside rule evaluation. An unrecognised value
  // here falls back to auto-detection rather than failing the request.
  const declaredJurisdiction =
    typeof jurisdictionField === 'string' && isJurisdictionId(jurisdictionField)
      ? jurisdictionField
      : undefined;

  let document: Awaited<ReturnType<typeof ingestBytes>>;
  try {
    if (file instanceof File && file.size > 0) {
      // `request.formData()` above has already buffered the upload once; `ingestBytes` enforces
      // this same limit but only after a second copy via `arrayBuffer()` and a parse attempt.
      // Checking `file.size` first skips that second copy and the parse, on a value the platform
      // already gave us for free — it does not bound the first buffer, which would need a
      // request-level body-size limit Next.js route handlers do not provide out of the box.
      if (file.size > LIMITS.maxFileBytes) {
        return NextResponse.json(
          {
            error: `The file is ${formatBytes(file.size)}. The limit is ${formatBytes(LIMITS.maxFileBytes)}.`,
          },
          { status: 413 },
        );
      }
      document = await ingestBytes(new Uint8Array(await file.arrayBuffer()));
    } else if (typeof text === 'string' && text.trim().length > 0) {
      document = ingestPastedText(text);
    } else {
      return NextResponse.json({ error: 'Paste lease text or choose a file.' }, { status: 400 });
    }
  } catch (error) {
    const message = isIngestError(error) ? error.message : 'The document could not be read.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const segmented = segment(document);
  const selection = await selectModel();

  try {
    const result = await analyse(segmented, {
      port: selection.port,
      ...(declaredJurisdiction === undefined ? {} : { declaredJurisdiction }),
    });

    return NextResponse.json({
      modelReason: selection.reason,
      offline: selection.offline,
      sourceKind: document.sourceKind,
      pageCount: document.pageCount,
      result: {
        ...result,
        explanations: Object.fromEntries(result.explanations),
        explanationAnchors: Object.fromEntries(result.explanationAnchors),
        usage: { ...result.usage, byTask: Object.fromEntries(result.usage.byTask) },
      },
    });
  } catch (error) {
    // `.userMessage`, never `.message`: a `ModelError`'s `message` can carry the raw vendor error
    // text (`classifyApiError` puts the provider's own response string there), and `userMessage`
    // is precisely the field that exists to keep that out of what a reader — or, here, an HTTP
    // response body — ever sees.
    const message = isModelError(error) ? error.userMessage : 'Analysis failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
