#!/usr/bin/env node
/** Real clone/fetch/push and complete data-root replacement; synthetic fixture only. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CoreStore } from '../packages/core/dist/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = { url: process.env.SCRIPTORIUM_ACCEPTANCE_GITHUB_URL };
if (!fixture.url || !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(fixture.url)) {
  throw new Error('Set SCRIPTORIUM_ACCEPTANCE_GITHUB_URL to an authorized disposable synthetic GitHub repository. This check commits and pushes synthetic metadata.');
}
const githubToken = process.env.SCRIPTORIUM_GITHUB_TOKEN ?? execFileSync('gh',['auth','token'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'scriptorium-live-p01-'));
const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
try {
  let store = new CoreStore({dataDir,githubToken});
  let project = await store.registerProject({url:fixture.url});
  const first = await store.observe(project.id);
  assert.equal(first.snapshot.repository.provider,'github');
  assert.match(first.snapshot.repository.repositoryId,/^[0-9]+$/);
  assert.equal(first.snapshot.repository.defaultBranch,'main');
  const operationId=randomUUID();
  const file='meta/acceptance/'+operationId+'.json';
  const operation={id:operationId,generation:1,repository:first.snapshot.repository,baseRemoteCommit:first.snapshot.remoteCommit,effect:'metadata',reads:[{path:file,revision:null}],writes:[{path:file,revision:null,content:JSON.stringify({synthetic:true,operationId})+'\n'}],message:'Verify synthetic Epic 7 checkpoint and publish'};
  const proposal=await store.propose(project.id,{id:'proposal-'+operationId,snapshot:first.snapshot,operations:[operation],source:'author'});
  await store.approve(project.id,{proposalId:proposal.id,operationIds:[operationId],authorScope:'owner'});
  const checkpoint=await store.checkpoint(project.id,operation);
  assert.equal((await store.reader(project.id,'remote')).snapshot.remoteCommit,first.snapshot.remoteCommit);
  assert.equal(await (await store.reader(project.id,'remote')).read(file),null);
  assert.ok(await (await store.reader(project.id,'checkpoint')).read(file));
  assert.equal((await store.observe(project.id)).pending.length,1);
  const batchId='batch-'+operationId;
  const published=await store.publish(project.id,batchId);
  assert.equal(published.state,'confirmed');
  assert.equal(published.acknowledged[0]?.operationId,operationId);
  const saved=await store.observe(project.id);
  assert.equal(saved.pending.length,0);
  assert.ok(await (await store.reader(project.id,'remote')).read(file));
  await fs.rm(dataDir,{recursive:true,force:true});
  store=new CoreStore({dataDir,githubToken});
  project=await store.registerProject({url:fixture.url});
  const restored=await store.observe(project.id);
  assert.equal(restored.snapshot.repository.repositoryId,first.snapshot.repository.repositoryId);
  const replayed=await store.publish(project.id,batchId);
  assert.equal(replayed.state,'confirmed');
  assert.equal(replayed.acknowledged[0]?.operationId,operationId);
  const beforeReplay=(await store.observe(project.id)).snapshot.remoteCommit;
  const existing=await store.checkpoint(project.id,operation);
  assert.equal(existing.operationId,checkpoint.operationId);
  assert.equal((await store.observe(project.id)).snapshot.remoteCommit,beforeReplay);
  const result={sourceCommit,repositoryId:first.snapshot.repository.repositoryId,defaultBranch:'main',checkpointCommit:checkpoint.localCommit,publishedRemoteCommit:published.remoteCommit,reconstructedRemoteCommit:restored.snapshot.remoteCommit,operationId,batchId,checks:{actualGitHubMetadata:true,actualCloneFetchPush:true,remoteAndCheckpointSeparated:true,checkpointPendingBeforePush:true,confirmedPublish:true,completeDataRootDeletion:true,stableIdentityAfterReclone:true,batchReceiptFromGitHistory:true,noDuplicateOperationReplay:true}};
  if (process.env.SCRIPTORIUM_ACCEPTANCE_RESULT) await fs.writeFile(process.env.SCRIPTORIUM_ACCEPTANCE_RESULT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {await fs.rm(dataDir,{recursive:true,force:true});}
