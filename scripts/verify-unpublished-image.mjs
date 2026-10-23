#!/usr/bin/env node
// Read-only registry check immediately before the existing image push.
import { assertImageTagAbsent, assertReleaseIdentity } from './release-policy.mjs';

const { IMAGE: image, TAG: tag, GITHUB_ACTOR: actor, GH_TOKEN: token, GITHUB_SHA: sha } = process.env;
if (!image || !/^ghcr\.io\/yohn-jp\/scriptorium\/(core|full)$/.test(image) || !tag || !actor || !token || !sha) {
  throw new Error('OCI immutability check requires the exact release image, tag and registry read credentials');
}
assertReleaseIdentity(tag, sha, sha);
const repository = image.slice('ghcr.io/'.length);
const auth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, {
  headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` },
  redirect: 'error', signal: AbortSignal.timeout(15_000),
});
if (!auth.ok) throw new Error(`Registry authorization check failed (HTTP ${auth.status})`);
/** @type {unknown} */
const credentials = await auth.json();
if (!credentials || typeof credentials !== 'object' || !('token' in credentials) || typeof credentials.token !== 'string' || !credentials.token) throw new Error('Registry read token is missing');
const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`, {
  headers: {
    Authorization: `Bearer ${credentials.token}`,
    Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
  },
  redirect: 'error', signal: AbortSignal.timeout(15_000),
});
await assertImageTagAbsent(response);
console.log(`Registry confirms ${image}:${tag} is absent; no publication performed by this check.`);
