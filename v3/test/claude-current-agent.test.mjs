import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {freeFetchSafePort} from './fetch-safe-port.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const binary=process.env.AGENTSESSION_V3_BIN||path.join(repo,'v3/target/debug',process.platform==='win32'?'agentsession-v3.exe':'agentsession-v3');
const fixture=path.join(repo,'v3/fixtures/claude-current-agent');
const digest=b=>createHash('sha256').update(b).digest('hex');

test('current structured Claude Agent launch connects the recorded child without inventing a run', {timeout:30000}, async t=>{
  const work=await mkdtemp(path.join(repo,'tmp/claude-current-agent-'));
  const source=path.join(fixture,'transcripts/parent.jsonl'),before=digest(await readFile(source));
  await cp(fixture,path.join(work,'claude'),{recursive:true});
  for(const name of ['codex','dsh','pi','meta','index','cache'])await mkdir(path.join(work,name));
  await writeFile(path.join(work,'config.json'),'{}');
  const args=['--config',path.join(work,'config.json'),'--claude-dir',path.join(work,'claude'),'--opencode-db',path.join(work,'missing.db'),...['codex','dsh','pi','meta','index','cache'].flatMap(name=>[`--${name}-dir`,path.join(work,name)])];
  const port=await freeFetchSafePort();
  const child=spawn(binary,['serve','--port',String(port),'--disable-terminal-launch',...args],{cwd:repo,windowsHide:true,stdio:['ignore','ignore','pipe']});
  const closed=once(child,'close');
  t.after(async()=>{child.kill();await closed;assert.equal(digest(await readFile(source)),before);await rm(work,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<200;i++){try{if((await fetch(base+'/api/providers')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  async function get(suffix){const response=await fetch(base+suffix),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;}
  const root='/api/v3/reader/claude-code/parent';
  const reader=await get(root+'/bootstrap');
  const relations=await get(root+'/relations?'+new URLSearchParams({cursor:reader.relations.firstCursor}));
  const starts=relations.entries.filter(e=>e.type==='coordination'&&e.observation.state==='started');
  assert.equal(starts.length,1);
  assert.deepEqual(starts[0].observation.toSessionRef,{provider:'claude-code',sessionId:'child'});
  assert.equal(starts[0].observation.eventId,'event:claude:2');
  assert.deepEqual(relations.childPlacements,[{child:{provider:'claude-code',sessionId:'child'},afterEvent:{provider:'claude-code',sessionId:'parent',messageId:'tool-result:agent-call',segment:'tool'},sourceEventId:'event:claude:2',diagnostic:null}]);
  assert.equal(relations.entries.find(e=>e.type==='task').task.description,'Agent "Run child marker check" finished');
  const protocol=await get('/api/v3/protocol/claude-code/parent?version=3');
  assert.equal(protocol.validation.ok,true);
  assert.deepEqual(protocol.agentRuns,[]);
  assert.deepEqual(protocol.coordination.map(e=>[e.kind,e.state,e.evidence.eventId]),[['spawn','requested','event:claude:1'],['spawn','started','event:claude:2']]);
  assert.ok(protocol.relationships.some(e=>e.kind==='child'&&e.to.sessionId==='child'));
  assert.equal((await get('/api/v3/reader/claude-code/child/bootstrap')).session.parent.sessionId,'parent');
});
