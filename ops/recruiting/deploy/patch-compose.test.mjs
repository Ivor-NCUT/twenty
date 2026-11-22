/** Proves an image-only patch keeps the live switch, memory and non-target services. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { patchAppImages, productionBaseline } from './patch-compose.mjs';

const live = `
services:
  server:
    mem_limit: 1280m
    image: fanhan-local/fanhan-twenty:1b2ff8f6bb70-mailreply1
    environment:
      RECRUITING_AUTO_MATCH_ENABLED: "true"
      APP_VERSION_NOTE: 2.55.0+0786a336235a
  worker:
    mem_limit: 3g
    image: fanhan-local/fanhan-twenty:1b2ff8f6bb70-mailreply1
  parser:
    image: ghcr.io/hedgeho9x/fanhan-mineru:keep
  migrate:
    image: ghcr.io/old/fanhan-twenty:exited-old
    mem_limit: 1536m
  db:
    image: postgres:16
  redis:
    image: redis:7
`;

test('replaces only server and worker app images', () => {
  const patched = patchAppImages(
    live,
    'ghcr.io/ivor-ncut/fanhan-twenty@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  assert.match(
    patched,
    /server:[\s\S]*image: ghcr.io\/ivor-ncut\/fanhan-twenty@sha256:aaa/,
  );
  assert.match(
    patched,
    /worker:[\s\S]*image: ghcr.io\/ivor-ncut\/fanhan-twenty@sha256:aaa/,
  );
  assert.match(patched, /RECRUITING_AUTO_MATCH_ENABLED: "true"/);
  assert.match(patched, /mem_limit: 1280m/);
  assert.match(patched, /mem_limit: 3g/);
  assert.match(patched, /fanhan-mineru:keep/);
  assert.match(patched, /fanhan-twenty:exited-old/);
  assert.match(patched, /postgres:16/);
  assert.doesNotMatch(patched, /RECRUITING_AUTO_MATCH_ENABLED: "false"/);
});

test('does not read an env file and does not turn a resolved true switch into the file value', () => {
  const baseline = productionBaseline();
  assert.equal(baseline.autoMatchResolved, true);
  assert.equal(baseline.mailreplyLayerInGit, true);
  assert.equal(baseline.workerMemory, '3g');
  const envFile =
    'RECRUITING_AUTO_MATCH_ENABLED=false\nSILICONFLOW_API_KEY=secret\n';
  const patched = patchAppImages(
    live,
    'ghcr.io/ivor-ncut/fanhan-twenty@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  );
  assert.equal(patched.includes('false'), false);
  assert.equal(patched.includes('secret'), false);
  assert.equal(envFile.includes('false'), true);
});

test('refuses a compose that is missing one app service image', () => {
  assert.throws(
    () =>
      patchAppImages(
        'services:\n  server:\n    image: fanhan-twenty:old\n',
        'ghcr.io/ivor-ncut/fanhan-twenty:new',
      ),
    /both server and worker/,
  );
});
