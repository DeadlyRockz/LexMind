/**
 * Dev-only bridge to `packages/core`'s `analyse()` pipeline, for the `/try` scratch page.
 *
 * Not part of the phase 10 deliverable (see `app/page.tsx`) — that owns the real upload flow,
 * accessibility work and design. This exists so the engine can be exercised from a browser before
 * phase 10 lands.
 */

import {
  analyse,
  ingestBytes,
  ingestPastedText,
  isIngestError,
  isModelError,
  type JurisdictionId,
  segment,
  selectModel,
} from '@lexmind/core';
import { NextResponse } from 'next/server';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  const text = form.get('text');
  const jurisdictionField = form.get('jurisdiction');
  const declaredJurisdiction =
    typeof jurisdictionField === 'string' && jurisdictionField.length > 0
      ? (jurisdictionField as JurisdictionId)
      : undefined;

  let document: Awaited<ReturnType<typeof ingestBytes>>;
  try {
    if (file instanceof File && file.size > 0) {
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
    const message = isModelError(error) ? error.message : 'Analysis failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
