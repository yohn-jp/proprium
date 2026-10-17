#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanRevision, assertCleanRevisionSnapshot, calculateBuildDigests, canonicalJson, trustedModuleData } from './hosted-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inTotoStatementV1 = 'https://in-toto.io/Statement/v1';
const slsaProvenanceV1 = 'https://slsa.dev/provenance/v1';
const catalogSubjectName = 'scriptorium-build/v1/catalog.json';
const runtimeMetadataSubjectName = 'scriptorium-platform/v1/runtime-metadata.json';
const sourceOrigin = 'https://github.com/yohn-jp/scriptorium';
const revisionPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const registryPattern = /^(?:[a-z0-9.-]+(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const bundleMediaType = 'application/vnd.dev.sigstore.bundle.v0.3+json';
const dssePayloadType = 'application/vnd.in-toto+json';
const cosignVersionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fail(message) {
  throw new Error(message);
}

function parseImmutableImageRef(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an immutable OCI image reference`);
  const at = value.lastIndexOf('@');
  const repository = at > 0 ? value.slice(0, at) : '';
  const digest = at > 0 ? value.slice(at + 1) : '';
  if (!registryPattern.test(repository) || !sha256Pattern.test(digest)) {
    fail(`${label} must be an OCI repository@sha256 digest`);
  }
  return { repository, digest };
}

function assertExternalOutput(filename, label) {
  const absolute = path.resolve(filename);
  const relative = path.relative(root, absolute);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    fail(`${label} must be written outside the producer checkout`);
  }
  return absolute;
}

async function readCanonicalJson(filename, label) {
  const bytes = await readFile(filename);
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
  if (canonicalJson(value) !== text) fail(`${label} is not the exact canonical JSON sidecar`);
  return { value, bytes };
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function assertCanonicalOrigin(remote) {
  const canonical = remote === 'git@github.com:yohn-jp/scriptorium.git' ||
    remote === 'ssh://git@github.com/yohn-jp/scriptorium.git' ||
    remote === 'https://github.com/yohn-jp/scriptorium' ||
    remote === 'https://github.com/yohn-jp/scriptorium.git';
  if (!canonical) fail('origin must be the canonical yohn-jp/scriptorium GitHub repository');
}

export function createSlsaStatement(input) {
  const { producerRevision, runtimeBaseImage, buildKitImage, catalog, runtimeMetadata, catalogBytes, runtimeMetadataBytes, sourceDigests } = input;
  if (!revisionPattern.test(producerRevision ?? '')) fail('producer revision must be a full immutable Git commit');
  const runtimeBase = parseImmutableImageRef(runtimeBaseImage, 'Runtime Base image');
  const buildKit = parseImmutableImageRef(buildKitImage, 'Build Kit image');
  if (!catalog || catalog.contractVersion !== 'scriptorium-build/v1' || catalog.producerRevision !== producerRevision ||
      catalog.runtimeBaseDigest !== runtimeBase.digest || catalog.buildKitDigest !== buildKit.digest) {
    fail('catalog does not bind the requested producer revision and immutable image digests');
  }
  if (!runtimeMetadata || runtimeMetadata.contractVersion !== 'scriptorium-platform/v1' || runtimeMetadata.producerRevision !== producerRevision) {
    fail('runtime metadata does not bind the requested producer revision');
  }
  for (const key of ['sourceDigest', 'recipeDigest', 'lockDigest']) {
    if (!sha256Pattern.test(catalog[key] ?? '') || sourceDigests?.[key] !== catalog[key]) {
      fail(`catalog ${key} does not match the clean producer source`);
    }
  }
  if (!(catalogBytes instanceof Uint8Array) || !(runtimeMetadataBytes instanceof Uint8Array)) {
    fail('canonical catalog and runtime metadata bytes are required');
  }
  const catalogDigest = sha256(catalogBytes);
  const runtimeMetadataDigest = sha256(runtimeMetadataBytes);
  const startedOn = input.startedOn ?? new Date().toISOString();
  const finishedOn = input.finishedOn ?? startedOn;
  const invocationId = input.invocationId ?? `urn:uuid:${randomUUID()}`;
  if (Number.isNaN(Date.parse(startedOn)) || Number.isNaN(Date.parse(finishedOn)) || Date.parse(finishedOn) < Date.parse(startedOn) ||
      typeof invocationId !== 'string' || invocationId.length === 0) {
    fail('SLSA run metadata is invalid');
  }

  return {
    _type: inTotoStatementV1,
    subject: [
      { name: runtimeBase.repository, digest: { sha256: runtimeBase.digest.slice('sha256:'.length) } },
      { name: catalogSubjectName, digest: { sha256: catalogDigest.slice('sha256:'.length) } },
      { name: runtimeMetadataSubjectName, digest: { sha256: runtimeMetadataDigest.slice('sha256:'.length) } },
    ],
    predicateType: slsaProvenanceV1,
    predicate: {
      buildDefinition: {
        buildType: `${sourceOrigin}/blob/${producerRevision}/Dockerfile`,
        externalParameters: {
          buildKitImage,
          producerRevision,
          runtimeBaseImage,
        },
        internalParameters: {
          catalogSourceDigest: catalog.sourceDigest,
          recipeDigest: catalog.recipeDigest,
          lockDigest: catalog.lockDigest,
        },
        resolvedDependencies: [
          { uri: `git+${sourceOrigin}`, digest: { gitCommit: producerRevision } },
          { uri: `${sourceOrigin}/source-inventory/v1`, digest: { sha256: catalog.sourceDigest.slice('sha256:'.length) } },
          { uri: `${sourceOrigin}/build-recipe/v1`, digest: { sha256: catalog.recipeDigest.slice('sha256:'.length) } },
          { uri: `${sourceOrigin}/blob/${producerRevision}/pnpm-lock.yaml`, digest: { sha256: catalog.lockDigest.slice('sha256:'.length) } },
          { uri: `oci://${buildKit.repository}`, digest: { sha256: buildKit.digest.slice('sha256:'.length) } },
        ],
      },
      runDetails: {
        builder: { id: `${sourceOrigin}/blob/${producerRevision}/scripts/hosted-attestation.mjs` },
        metadata: { invocationId, startedOn, finishedOn },
      },
    },
  };
}

export function assertSigstoreBundleMatches(bundleValue, statementBytes) {
  if (!bundleValue || typeof bundleValue !== 'object' || Array.isArray(bundleValue) ||
      bundleValue.mediaType !== bundleMediaType || !bundleValue.verificationMaterial ||
      !bundleValue.dsseEnvelope || typeof bundleValue.dsseEnvelope !== 'object') {
    fail('cosign output is not the Sigstore protobuf v0.3 DSSE bundle consumed by Praetorium');
  }
  const envelope = bundleValue.dsseEnvelope;
  if (envelope.payloadType !== dssePayloadType || typeof envelope.payload !== 'string' ||
      !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1 ||
      envelope.signatures.some((item) => !item || typeof item.sig !== 'string' || item.sig.length === 0)) {
    fail('cosign bundle is unsigned or does not contain an in-toto DSSE envelope');
  }
  let payload;
  try {
    payload = Buffer.from(envelope.payload, 'base64');
  } catch {
    fail('cosign bundle DSSE payload is not valid base64');
  }
  if (payload.toString('base64') !== envelope.payload || !Buffer.from(statementBytes).equals(payload)) {
    fail('cosign bundle does not sign the exact canonical SLSA statement');
  }
  const certificateBytes = bundleValue.verificationMaterial.certificate?.rawBytes;
  const tlogEntries = bundleValue.verificationMaterial.tlogEntries;
  if (typeof certificateBytes !== 'string' || certificateBytes.length === 0 ||
      Buffer.from(certificateBytes, 'base64').toString('base64') !== certificateBytes ||
      !Array.isArray(tlogEntries) || tlogEntries.length === 0 ||
      tlogEntries.some((entry) => !entry?.logId || !entry?.kindVersion || !entry?.inclusionProof?.checkpoint)) {
    fail('cosign bundle lacks the Sigstore certificate or protobuf transparency proof');
  }
  return true;
}

async function readAndValidateInputs(args) {
  const required = ['--catalog', '--runtime-metadata', '--runtime-base-image', '--build-kit-image'];
  if (required.some((key) => !args[key])) fail(`producer statement requires ${required.join(', ')}`);
  const revision = gitOutput(['rev-parse', 'HEAD']);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (status.error) throw status.error;
  if (status.status !== 0) fail('Could not inspect producer checkout status');
  assertCleanRevisionSnapshot({ head: revision, status: status.stdout, producerRevision: revision });
  await assertCleanRevision(revision);
  assertCanonicalOrigin(gitOutput(['remote', 'get-url', 'origin']));

  const [{ value: catalog, bytes: catalogBytes }, { value: runtimeMetadata, bytes: runtimeMetadataBytes }] = await Promise.all([
    readCanonicalJson(args['--catalog'], 'build catalog'),
    readCanonicalJson(args['--runtime-metadata'], 'runtime metadata'),
  ]);
  const runtimeBase = parseImmutableImageRef(args['--runtime-base-image'], 'Runtime Base image');
  const buildKit = parseImmutableImageRef(args['--build-kit-image'], 'Build Kit image');
  if (catalog.runtimeBaseDigest !== runtimeBase.digest || catalog.buildKitDigest !== buildKit.digest) {
    fail('immutable image references do not match the producer catalog');
  }

  const digests = await calculateBuildDigests();
  const sourceDigests = {
    sourceDigest: digests.sourceDigest,
    recipeDigest: digests.recipeDigest,
    lockDigest: digests.lockDigest,
  };
  const catalogBuild = await import(pathToFileURL(path.join(root, 'packages/module-runtime/dist/index.js')).href);
  if (typeof catalogBuild.resolveBuildCatalogSelection !== 'function') fail('Build the module-runtime package before producer attestation');
  catalogBuild.resolveBuildCatalogSelection(catalog, [], await trustedModuleData());
  const platform = await import(pathToFileURL(path.join(root, 'packages/api/dist/platform-runtime.js')).href);
  if (typeof platform.metadataForRuntime !== 'function') fail('Build the API package before producer attestation');
  const expectedMetadata = platform.metadataForRuntime({ producerRevision: revision, port: 3000, shutdownTimeoutSeconds: 25 });
  if (canonicalJson(runtimeMetadata) !== canonicalJson(expectedMetadata)) fail('runtime metadata differs from the existing producer platform contract');

  const statement = createSlsaStatement({
    producerRevision: revision,
    runtimeBaseImage: args['--runtime-base-image'],
    buildKitImage: args['--build-kit-image'],
    catalog,
    runtimeMetadata,
    catalogBytes,
    runtimeMetadataBytes,
    sourceDigests,
  });
  return { statement, catalogBytes, catalog, revision };
}

async function writeStatement(args) {
  const output = assertExternalOutput(args['--statement-out'], 'Statement');
  try { await access(output); fail('Statement output already exists; choose a new external path'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const { statement } = await readAndValidateInputs(args);
  const bytes = Buffer.from(canonicalJson(statement), 'utf8');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, bytes, { mode: 0o600 });
  return { output, bytes };
}

export function parseCosignVersion(version) {
  const match = cosignVersionPattern.exec(version ?? '');
  if (!match) fail('--cosign-version must pin an exact semantic version');
  const parsed = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
  if (Object.values(parsed).some((value) => typeof value === 'number' && !Number.isSafeInteger(value))) {
    fail('--cosign-version contains an unsupported version component');
  }
  return parsed;
}

export function assertSupportedCosignVersion(version) {
  const { major, minor, patch, prerelease } = parseCosignVersion(version);
  const supported = prerelease === null && (
    (major === 2 && (minor > 6 || (minor === 6 && patch >= 5))) ||
    (major === 3 && (minor > 1 || (minor === 1 && patch >= 3)))
  );
  if (!supported) fail('Cosign version is unsupported or affected by GHSA-fx35-mq7g-6g98; require v2.6.5+ or v3.1.3+');
  return true;
}

function exactCosignVersion(binary, expectedVersion) {
  assertSupportedCosignVersion(expectedVersion);
  const result = spawnSync(binary, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) fail('Could not read the configured cosign binary version');
  const actual = `${result.stdout}\n${result.stderr}`.match(/GitVersion:\s*(v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/u)?.[1];
  const expected = expectedVersion.replace(/^v/u, '');
  if (!actual || actual.replace(/^v/u, '') !== expected) fail(`configured cosign binary version does not match pinned v${expected}`);
  assertSupportedCosignVersion(actual);
}

export async function pinnedCosignBinary(binary, expectedVersion, expectedDigest) {
  if (!path.isAbsolute(binary) || !/^sha256:[a-f0-9]{64}$/u.test(expectedDigest ?? '')) {
    fail('--cosign-bin must be an absolute path and --cosign-sha256 must pin its SHA-256 digest');
  }
  const resolved = await realpath(binary);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) fail('configured cosign binary is not a regular file');
  await access(resolved, fsConstants.X_OK);
  const binaryDigest = sha256(await readFile(resolved));
  if (binaryDigest !== expectedDigest) fail('configured cosign binary does not match --cosign-sha256');
  exactCosignVersion(resolved, expectedVersion);
  return resolved;
}

function runCosign(binary, args, label) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${label} failed with cosign exit status ${String(result.status)}`);
}

function validatePublishUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('--publish-url must be an HTTPS immutable bundle URL'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    fail('--publish-url must be an HTTPS URL without credentials, query, or fragment');
  }
  return url;
}

async function publishBundle(url, bytes, tokenEnvironmentVariable) {
  const target = validatePublishUrl(url);
  const tokenName = tokenEnvironmentVariable;
  if (tokenName !== undefined && !/^[A-Z_][A-Z0-9_]*$/u.test(tokenName)) fail('--registry-token-env must be an environment variable name');
  const token = tokenName ? process.env[tokenName] : undefined;
  if (tokenName && !token) fail(`required owner registry credential ${tokenName} is not set`);
  const headers = {
    'content-type': bundleMediaType,
    'cache-control': 'public, immutable, no-transform',
    'if-none-match': '*',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let put;
  try {
    put = await fetch(target, { method: 'PUT', headers, body: bytes, redirect: 'error' });
  } catch {
    fail('HTTPS owner registry upload failed');
  }
  if (!put.ok && put.status !== 409 && put.status !== 412) fail(`HTTPS owner registry returned ${put.status} for immutable bundle upload`);
  let get;
  try {
    get = await fetch(target, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error' });
  } catch {
    fail('HTTPS owner registry readback failed');
  }
  if (!get.ok) fail(`HTTPS owner registry returned ${get.status} for bundle readback`);
  const retrieved = new Uint8Array(await get.arrayBuffer());
  if (!Buffer.from(retrieved).equals(Buffer.from(bytes))) fail('HTTPS owner registry readback does not match the signed bundle bytes');
  return target.toString();
}

async function attest(args) {
  const required = ['--catalog', '--runtime-metadata', '--runtime-base-image', '--build-kit-image', '--statement-out', '--bundle-out', '--cosign-bin', '--cosign-version', '--cosign-sha256', '--certificate-identity', '--certificate-oidc-issuer'];
  if (required.some((key) => !args[key])) fail(`attest requires ${required.join(', ')}`);
  const statementPath = assertExternalOutput(args['--statement-out'], 'Statement');
  const bundlePath = assertExternalOutput(args['--bundle-out'], 'Sigstore bundle');
  if (statementPath === bundlePath) fail('Statement and Sigstore bundle outputs must use different paths');
  try { await access(bundlePath); fail('Sigstore bundle output already exists; choose a new external path'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!args['--certificate-identity'].trim()) fail('--certificate-identity must be an exact allowed SAN');
  let issuer;
  try { issuer = new URL(args['--certificate-oidc-issuer']); } catch { fail('--certificate-oidc-issuer must be an HTTPS issuer URL'); }
  if (issuer.protocol !== 'https:' || issuer.username !== '' || issuer.password !== '') fail('--certificate-oidc-issuer must be an HTTPS issuer URL');
  const { output: writtenStatement, bytes: statementBytes } = await writeStatement({ ...args, '--statement-out': statementPath });
  const cosign = await pinnedCosignBinary(args['--cosign-bin'], args['--cosign-version'], args['--cosign-sha256']);
  const temporaryBundle = `${bundlePath}.${process.pid}.pending`;
  await rm(temporaryBundle, { force: true });
  try {
    runCosign(cosign, [
      'attest-blob', '--yes', '--tlog-upload=true', '--new-bundle-format=true', '--statement', writtenStatement,
      '--bundle', temporaryBundle, args['--catalog'],
    ], 'Sigstore signing');
    const bundleBytes = await readFile(temporaryBundle);
    let bundleValue;
    try { bundleValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes)); }
    catch { fail('cosign did not emit a valid Sigstore bundle JSON document'); }
    assertSigstoreBundleMatches(bundleValue, statementBytes);
    runCosign(cosign, [
      'verify-blob-attestation', '--new-bundle-format=true', '--bundle', temporaryBundle,
      '--type', slsaProvenanceV1,
      '--certificate-identity', args['--certificate-identity'],
      '--certificate-oidc-issuer', args['--certificate-oidc-issuer'],
      args['--catalog'],
    ], 'Sigstore bundle verification');
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await rename(temporaryBundle, bundlePath);
    const result = { statement: writtenStatement, bundle: bundlePath, bundleDigest: sha256(bundleBytes) };
    if (args['--publish-url']) {
      result.signatureRef = await publishBundle(args['--publish-url'], bundleBytes, args['--registry-token-env']);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    await rm(temporaryBundle, { force: true });
    throw error;
  }
}

function parseFlags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--') || values[key] !== undefined) fail('Invalid hosted attestation arguments');
    values[key] = argv[++index];
  }
  return values;
}

function usage() {
  return 'Usage: node scripts/hosted-attestation.mjs statement --catalog <canonical-file> --runtime-metadata <canonical-file> --runtime-base-image <repo@sha256:digest> --build-kit-image <repo@sha256:digest> --statement-out <external-file> | attest [same inputs] --bundle-out <external-file> --cosign-bin <absolute-pinned-cosign> --cosign-version <exact-version> --cosign-sha256 sha256:<64-hex> --certificate-identity <allowlisted-SAN> --certificate-oidc-issuer <allowlisted-issuer> [--publish-url <immutable-https-url> [--registry-token-env <ENV_NAME>]]';
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const args = parseFlags(rest);
  if (command === 'statement') {
    const { output, bytes } = await writeStatement(args);
    process.stdout.write(`${JSON.stringify({ statement: output, digest: sha256(bytes) })}\n`);
    return;
  }
  if (command === 'attest') {
    await attest(args);
    return;
  }
  fail(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Hosted attestation failed');
    process.exitCode = 1;
  });
}
