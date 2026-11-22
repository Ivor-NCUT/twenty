/** Deploys one app image onto the live compose. It never reads a server .env or replaces other services. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchAppImages } from './patch-compose.mjs';

const assertLayer = spawnSync(
  process.execPath,
  [new URL('./assert-mailreply-preserved.mjs', import.meta.url).pathname],
  { stdio: 'inherit' },
);
if (assertLayer.status !== 0) process.exit(assertLayer.status ?? 1);

const apiKey = process.env.DOKPLOY_API_KEY ?? '';
const composeId = process.env.DOKPLOY_COMPOSE_ID ?? '';
const appImage = process.env.APP_IMAGE ?? '';
const appVersion = process.env.APP_VERSION ?? '';
const registryHost = process.env.REGISTRY_HOST || 'ghcr.io';
if (!apiKey || !composeId || !appImage || !appVersion)
  throw new Error('Missing deploy contract values');
if (!['ghcr.io', 'ghcr.nju.edu.cn'].includes(registryHost))
  throw new Error('Registry host is not allowlisted');
if (!appImage.startsWith('ghcr.io/ivor-ncut/fanhan-twenty@sha256:'))
  throw new Error('Refusing an image outside ghcr.io/ivor-ncut/fanhan-twenty');

const deployedImage = appImage.replace('ghcr.io/', `${registryHost}/`);
const directory = mkdtempSync(join(tmpdir(), 'fanhan-deploy-'));
const keyPath = join(directory, 'tunnel');
const knownHosts = join(directory, 'known_hosts');
const headerPath = join(directory, 'headers');
writeFileSync(keyPath, `${process.env.DEPLOY_TUNNEL_KEY ?? ''}\n`, {
  mode: 0o600,
});
writeFileSync(knownHosts, `${process.env.KNOWN_HOSTS ?? ''}\n`, {
  mode: 0o600,
});
writeFileSync(headerPath, `x-api-key: ${apiKey}\n`, { mode: 0o600 });

const redact = (text) => text.split(apiKey).join('[redacted]');
const tunnel = () => {
  const result = spawnSync(
    'ssh',
    [
      '-fN',
      '-i',
      keyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:23090:127.0.0.1:3000',
      'fanhan-deploy@43.136.55.30',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(redact(result.stderr || 'Tunnel failed'));
};

const dokploy = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:23090${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(redact(`Dokploy ${path} failed (${response.status})`));
  return text ? JSON.parse(text) : {};
};

const clientConfig = async () => {
  const response = await fetch('https://43.136.55.30/client-config', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  return response.json();
};

const healthy = async (expectedVersion) => {
  const health = await fetch('https://43.136.55.30/healthz', {
    signal: AbortSignal.timeout(10_000),
  });
  const config = await clientConfig();
  return (
    health.ok &&
    config?.appVersion === expectedVersion &&
    config?.serverUrl === 'https://43.136.55.30'
  );
};

const waitFor = async (expectedVersion) => {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await healthy(expectedVersion)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return false;
};

try {
  const before = await clientConfig();
  const previousVersion = before?.appVersion;
  if (typeof previousVersion !== 'string' || !previousVersion)
    throw new Error('Refusing to deploy without the current public appVersion');
  tunnel();
  const current = await dokploy('/api/compose.one', { composeId });
  const live = current.composeFile ?? current.compose?.composeFile;
  if (typeof live !== 'string')
    throw new Error('Refusing to deploy without the live compose file');
  const patched = patchAppImages(live, deployedImage);
  await dokploy('/api/compose.update', { composeId, composeFile: patched });
  await dokploy('/api/compose.deploy', {
    composeId,
    title: `Verified app image ${process.env.GITHUB_SHA ?? appVersion}`,
    description: appVersion,
  });
  if (await waitFor(appVersion)) {
    console.log(`Verified deployed revision ${appVersion}`);
  } else {
    await dokploy('/api/compose.update', { composeId, composeFile: live });
    await dokploy('/api/compose.deploy', {
      composeId,
      title: 'Rollback app image',
      description: previousVersion,
    });
    if (!(await waitFor(previousVersion)))
      throw new Error('Rollback did not return the previous public appVersion');
    throw new Error(
      'Deployment failed closed and the previous app image was restored',
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
