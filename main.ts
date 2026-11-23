import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const POST_FILE_MAX_BYTES = 16_384;
const URL_MAX_BYTES = 2_048;
const UINT64_MAX = (1n << 64n) - 1n;
const PHOTO_PATH = join(SCRIPT_DIR, 'photo.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface XPostAddress {
  handle: string | null;
  id: string;
}

function resolveInput(name: string): string {
  const besideScript = join(SCRIPT_DIR, name);
  if (existsSync(besideScript)) return besideScript;
  return join(process.cwd(), name);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseXPostAddress(value: unknown): XPostAddress {
  if (typeof value !== 'string') fail('POST.json url must be a string');

  const url = value.trim();
  if (url.length === 0) fail('POST.json url must not be empty');
  if (Buffer.byteLength(url, 'utf8') > URL_MAX_BYTES) {
    fail(`POST.json url must be at most ${URL_MAX_BYTES} bytes`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('POST.json url must be a valid x.com or twitter.com post address');
  }

  if (parsed.protocol !== 'https:') {
    fail('POST.json url must use https');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    fail('POST.json url must not carry credentials or a port');
  }

  const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, '');
  if (host !== 'x.com' && host !== 'twitter.com') {
    fail('POST.json url must be on x.com or twitter.com');
  }

  const segments = parsed.pathname.split('/').filter((part) => part.length > 0);
  let handle: string | null = null;
  let id: string | undefined;

  if (segments.length === 4 && segments[0]?.toLowerCase() === 'i' && segments[1]?.toLowerCase() === 'web') {
    const kind = segments[2]?.toLowerCase();
    if (kind === 'status' || kind === 'statuses') id = segments[3];
  } else if (segments.length === 3) {
    const kind = segments[1]?.toLowerCase();
    if (kind === 'status' || kind === 'statuses') {
      handle = segments[0];
      id = segments[2];
    }
  }

  if (id === undefined) {
    fail('POST.json url must have the form https://x.com/<handle>/status/<digits> (query and fragment ignored)');
  }
  if (handle !== null && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    fail('POST.json url has an invalid X handle');
  }
  if (!/^[0-9]+$/.test(id)) fail('POST.json post id must contain digits only');
  if (BigInt(id) > UINT64_MAX) fail('POST.json post id must be below 2^64');

  return { handle, id };
}

function buildDossier(post: XPostAddress, sourceUrl: string, png: Buffer): Buffer {
  const author = post.handle === null ? 'unknown' : `@${post.handle}`;
  const text = [
    'A post on X',
    `Author: ${author}`,
    'Posted: unknown (main.ts does not read X)',
    'Text:',
    sourceUrl,
  ].join('\n');

  return Buffer.from(
    JSON.stringify({
      schema: 'makefun/dossier/v1',
      cover: 0,
      text,
      images: [
        {
          name: 'photo.png',
          media_type: 'image/png',
          sha256: createHash('sha256').update(png).digest('hex'),
          base64: png.toString('base64'),
        },
      ],
    }),
    'utf8',
  );
}

function readPhoto(): Buffer {
  let png: Buffer;
  try {
    png = readFileSync(PHOTO_PATH);
  } catch (error) {
    fail(`photo.png could not be read from ${PHOTO_PATH}: ${(error as Error).message}`);
  }
  if (png.byteLength < PNG_SIGNATURE.byteLength || !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    fail(`photo.png at ${PHOTO_PATH} is not a PNG image`);
  }
  return png;
}

function main(): void {
  const postPath = resolveInput('POST.json');
  const licensePath = resolveInput('LICENSE');
  const png = readPhoto();
  let bytes: Buffer;
  try {
    bytes = readFileSync(postPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail(`POST.json is missing beside main.ts and in ${process.cwd()}`);
    fail(`POST.json could not be read from ${postPath}: ${(error as Error).message}`);
  }

  if (bytes.byteLength > POST_FILE_MAX_BYTES) {
    fail(`POST.json is ${bytes.byteLength} bytes; the limit is ${POST_FILE_MAX_BYTES}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`POST.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    fail('POST.json must contain one JSON object');
  }
  if (!Object.hasOwn(document, 'url')) fail('POST.json must contain a url field');

  const post = parseXPostAddress((document as { url: unknown }).url);
  const sourceUrl = ((document as { url: string }).url).trim();

  mkdirSync(OUTPUT_DIR, { recursive: true });
  try {
    copyFileSync(postPath, join(OUTPUT_DIR, 'POST.json'));
    copyFileSync(licensePath, join(OUTPUT_DIR, 'LICENSE'));
    writeFileSync(join(OUTPUT_DIR, 'dossier.json'), buildDossier(post, sourceUrl, png), { flag: 'w' });
  } catch (error) {
    fail(`could not write the output files to ${OUTPUT_DIR}: ${(error as Error).message}`);
  }

  const who = post.handle === null ? `status ${post.id}` : `@${post.handle} status ${post.id}`;
  console.log(`wrote POST.json, LICENSE and dossier.json to ${OUTPUT_DIR} for ${who}`);
}

try {
  main();
} catch (error) {
  console.error(`main.ts: ${(error as Error).message}`);
  process.exitCode = 1;
}
