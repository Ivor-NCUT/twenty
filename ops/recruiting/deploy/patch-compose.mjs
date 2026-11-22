/** Replaces only the running app image lines. Environment, memory and other services stay byte-for-byte. */
import { readFileSync } from 'node:fs';

const APP_SERVICES = new Set(['server', 'worker']);

/** Returns the compose with server and worker fanhan-twenty images replaced. */
export const patchAppImages = (compose, appImage) => {
  if (typeof compose !== 'string' || !compose.trim())
    throw new Error('Refusing to deploy without the live compose');
  if (!/^[\w./:@-]+$/.test(appImage))
    throw new Error('Refusing an image reference with unexpected characters');
  const lines = compose.split('\n');
  let service = '';
  let replaced = 0;
  const next = lines.map((line) => {
    const serviceLine = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (serviceLine) service = serviceLine[1];
    if (
      !APP_SERVICES.has(service) ||
      !/^\s+image:\s+\S*fanhan-twenty\S*\s*$/.test(line)
    )
      return line;
    replaced += 1;
    return `${line.match(/^\s*/)[0]}image: ${appImage}`;
  });
  if (replaced !== 2)
    throw new Error(
      'Refusing to deploy unless both server and worker app images are present',
    );
  const patched = next.join('\n');
  assertUntouched(compose, patched);
  return patched;
};

/** Fails if anything except the two app image lines changed. */
export const assertUntouched = (before, after) => {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length !== right.length)
    throw new Error('Compose line count changed');
  for (let index = 0; index < left.length; index++) {
    if (left[index] === right[index]) continue;
    if (!/^\s+image:\s+\S*fanhan-twenty\S*\s*$/.test(left[index]))
      throw new Error(`Refusing to change non-image line ${index + 1}`);
  }
  for (const marker of ['mem_limit:', 'RECRUITING_AUTO_MATCH_ENABLED']) {
    if (linesContaining(before, marker) !== linesContaining(after, marker))
      throw new Error(`Refusing to change ${marker}`);
  }
};

const linesContaining = (text, marker) =>
  text
    .split('\n')
    .filter((line) => line.includes(marker))
    .join('\n');

/** Reads the committed baseline. It does not open a server .env. */
export const productionBaseline = () =>
  JSON.parse(
    readFileSync(
      new URL('./PRODUCTION_BASELINE.json', import.meta.url),
      'utf8',
    ),
  );
