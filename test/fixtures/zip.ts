import { deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer, used to build DOCX fixtures in test setup.
 *
 * Fixtures are generated programmatically rather than committed, for three reasons: the
 * repository must stay under 10 MB, a public repository must not contain a real tenancy
 * agreement with someone's address in it, and a zip bomb is not something to have sitting in a
 * git history.
 *
 * `node:zlib` is in the standard library, so the adversarial fixtures — a genuine 1000:1
 * compression bomb among them — need no dependency at all.
 */

export interface ZipInput {
  readonly name: string;
  readonly content: string | Uint8Array;
  /** Store uncompressed. Used to build an entry with a 1:1 ratio on purpose. */
  readonly store?: boolean;
}

const LOCAL_SIGNATURE = 0x0403_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const EOCD_SIGNATURE = 0x0605_4b50;

// CRC-32, table-driven. The ZIP central directory carries it per entry and mammoth checks it.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xeda8_8320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function buildZip(inputs: readonly ZipInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const raw = typeof input.content === 'string' ? encoder.encode(input.content) : input.content;
    const stored = input.store === true;
    const body = stored ? raw : new Uint8Array(deflateRawSync(raw));
    const name = encoder.encode(input.name);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, stored ? 0 : 8, true); // method: store or deflate
    localView.setUint32(14, crc, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    chunks.push(local, body);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, CENTRAL_SIGNATURE, true);
    entryView.setUint16(4, 20, true); // version made by
    entryView.setUint16(6, 20, true); // version needed
    entryView.setUint16(10, stored ? 0 : 8, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, body.length, true);
    entryView.setUint32(24, raw.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    offset += local.length + body.length;
  }

  const directory = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, inputs.length, true);
  eocdView.setUint16(10, inputs.length, true);
  eocdView.setUint32(12, directory.length, true);
  eocdView.setUint32(16, offset, true);

  return concat([...chunks, directory, eocd]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export interface DocxParagraph {
  readonly text: string;
  /** 1-6 to emit a real Word heading style, which is what mammoth maps to `<h1>`-`<h6>`. */
  readonly heading?: number;
}

function paragraphXml(paragraph: DocxParagraph): string {
  const style =
    paragraph.heading === undefined
      ? ''
      : `<w:pPr><w:pStyle w:val="Heading${paragraph.heading}"/></w:pPr>`;
  const escaped = paragraph.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}

export function documentXml(paragraphs: readonly DocxParagraph[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs.map(paragraphXml).join('')}</w:body>
</w:document>`;
}

/** A well-formed DOCX with real heading styles. */
export function buildDocx(paragraphs: readonly DocxParagraph[]): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    { name: 'word/document.xml', content: documentXml(paragraphs) },
  ]);
}

/**
 * A DOCX whose `word/document.xml` is a compression bomb.
 *
 * This is the severe shape, not the harmless one: a bomb in an unreferenced entry is never
 * decompressed, but `word/document.xml` is the one entry the parser must open. A measured 238 KB
 * upload of this form expanded to 61 MB of XML and 2.2 GB of RSS in 2.5 seconds.
 */
export function buildZipBombDocx(repeatBytes = 8_000_000): Uint8Array {
  const filler = ' '.repeat(repeatBytes);
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

/** A DOCX carrying an XXE payload: an external entity pointed at a local file. */
export function buildXxeDocx(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

/** A DOCX carrying the billion-laughs entity expansion. */
export function buildBillionLaughsDocx(): Uint8Array {
  const entities = Array.from(
    { length: 9 },
    (_, i) =>
      `<!ENTITY lol${i + 1} "${i === 0 ? 'lol'.repeat(10) : `&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};&lol${i};`}">`,
  ).join('\n');
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: RELS },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE w:document [
${entities}
]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

/** A zip with too many entries, to exercise the entry-count ceiling. */
export function buildManyEntryZip(count: number): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: 'word/document.xml', content: documentXml([{ text: 'Lease.' }]) },
    ...Array.from({ length: count }, (_, i) => ({ name: `extra/${i}.xml`, content: '<a/>' })),
  ]);
}

/** A spreadsheet, to prove the refusal names what was actually uploaded. */
export function buildXlsx(): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
  ]);
}
