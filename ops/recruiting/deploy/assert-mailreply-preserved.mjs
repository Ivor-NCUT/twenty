/** Blocks an app-image rollout until the production mailreply layer is actually in git. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(directory, 'PRODUCTION_BASELINE.json'), 'utf8'),
);
const markerPath = join(directory, 'mailreply-preserved.json');

if (!existsSync(markerPath)) {
  console.error(
    [
      'Refusing to publish or deploy.',
      `Production server/worker image ${baseline.serverImage}`,
      `digest ${baseline.imageDigest}`,
      `reports appVersion ${baseline.appVersion}.`,
      'That mailreply1 layer is not in this git tree.',
      'Recover it from the running image before replacing either service.',
      'Do not infer the version from the exited migrate container.',
    ].join('\n'),
  );
  process.exit(1);
}

const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (
  marker.image !== baseline.serverImage ||
  marker.digest !== baseline.imageDigest ||
  typeof marker.sourceCommit !== 'string' ||
  !/^[0-9a-f]{40}$/.test(marker.sourceCommit)
) {
  console.error(
    'mailreply-preserved.json does not match the production baseline',
  );
  process.exit(1);
}
