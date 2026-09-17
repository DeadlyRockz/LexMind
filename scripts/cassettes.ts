import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCassetteFiles, CASSETTE_ROOT, serialiseCassette } from '../test/cassettes/build.ts';

/**
 * Write the offline replay cassettes: `pnpm cassettes`.
 *
 * Every response written here is HAND-AUTHORED and SYNTHETIC (`test/cassettes/responses.ts`). This
 * script calls no model and needs no API key: it runs the real `analyse()` against a port that only
 * records requests, takes each cassette key from the request the replay adapter will actually
 * receive, and pairs it with the authored response.
 *
 * Re-run it whenever a prompt, a schema, the safety preamble or a golden lease changes — any of
 * those changes the key, and `test/cassette-e2e.test.ts` fails until the files are rewritten. Stale
 * files are removed first, so a renamed key cannot leave an orphan behind.
 */

const files = await buildCassetteFiles();
const directories = new Set(files.map((file) => file.directory));

for (const directory of directories) {
  const absolute = join(CASSETTE_ROOT, directory);
  mkdirSync(absolute, { recursive: true });
  for (const name of readdirSync(absolute)) {
    if (name.endsWith('.json')) rmSync(join(absolute, name));
  }
}

for (const file of files) {
  writeFileSync(
    join(CASSETTE_ROOT, file.directory, file.fileName),
    serialiseCassette(file.cassette),
  );
}

console.log(`Wrote ${files.length} synthetic cassettes across ${directories.size} directories.`);
