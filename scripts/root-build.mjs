#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBuildCommands } from './profile-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createRootBuildCommands(profileName, profile) {
  const selectedProfile = profileName || 'core';
  if (selectedProfile === 'core') {
    if (profile?.profile !== 'core' || !Array.isArray(profile.modules)) {
      throw new Error('Invalid Core profile manifest');
    }
    return createBuildCommands('core', profile);
  }

  return [{ command: 'pnpm', args: ['run', 'build:workspace'] }];
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

async function main() {
  const profileName = process.env.SCRIPTORIUM_PROFILE || 'core';
  const profile = profileName === 'core'
    ? JSON.parse(await readFile(path.join(root, 'profiles/core.json'), 'utf8'))
    : undefined;

  for (const step of createRootBuildCommands(profileName, profile)) {
    run(step.command, step.args, step.env);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Root build failed');
    process.exitCode = 1;
  });
}
