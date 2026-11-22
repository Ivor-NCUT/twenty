/** Blocks an app-image rollout until the production mailreply behavior is in a real commit. */
import { spawnSync } from 'node:child_process';
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

const git = (args) =>
  spawnSync('git', args, { cwd: join(directory, '../../..'), encoding: 'utf8' });
const sourceFile =
  'packages/twenty-server/src/modules/recruiting/mail/domain/mail-reply.ts';
const behaviorFile =
  'packages/twenty-server/src/modules/recruiting/intake/intake.service.ts';
const source = git(['cat-file', '-e', `${marker.sourceCommit}:${sourceFile}`]);
const ancestor = git(['merge-base', '--is-ancestor', marker.sourceCommit, 'HEAD']);
const behavior = git([
  'grep',
  '-q',
  'mailAttachOnly',
  marker.sourceCommit,
  '--',
  behaviorFile,
]);
if (source.status !== 0 || ancestor.status !== 0 || behavior.status !== 0) {
  console.error(
    `Refusing marker ${marker.sourceCommit}: it does not contain the mail-reply source on this branch`,
  );
  process.exit(1);
}
