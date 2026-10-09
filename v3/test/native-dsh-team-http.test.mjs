import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const source=path.join(repo,'v3/fixtures/deepseek-harness-native-team');
const binary=process.env.AGENTSESSION_V3_BIN||path.join(repo,'v3/target/debug',process.platform==='win32'?'agentsession-v3.exe':'agentsession-v3');
const provider='deepseek-harness';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function setup(t, mutate) {
  const temp=await mkdtemp(path.join(repo,'tmp/native-dsh-http-')); const ledger=[];
  const dirs=Object.fromEntries(['codex','claude','pi','dsh','meta','index','cache'].map(n=>[n,path.join(temp,n)]));
  for(const d of Object.values(dirs))await mkdir(d);
  for(const id of ['native-team-parent','native-team-child']){
    const file=path.join(source,'sessions/public',id,'session.v3.jsonl'); const bytes=await readFile(file);ledger.push({file,sha:hash(bytes)});
    const rows=bytes.toString('utf8').trim().split('\n').map(JSON.parse);if(mutate)mutate(rows,id);
    const dest=path.join(dirs.dsh,'sessions/public',id,'session.v3.jsonl');await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,rows.map(JSON.stringify).join('\n')+'\n');
  }
  const port=await freeFetchSafePort(); const child=spawn(binary,['serve','--port',String(port),'--codex-dir',dirs.codex,'--claude-dir',dirs.claude,'--pi-dir',dirs.pi,'--dsh-dir',dirs.dsh,'--opencode-db',path.join(temp,'missing.db'),'--meta-dir',dirs.meta,'--index-dir',dirs.index,'--cache-dir',dirs.cache],{cwd:repo,windowsHide:true,stdio:['ignore','ignore','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'close');}for(const x of ledger)assert.equal(hash(await readFile(x.file)),x.sha);await rm(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<200;i++){try{if((await fetch(base+'/api/providers')).ok)return base;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Native service unavailable');
}
async function json(url,status=200){const r=await fetch(url);const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b;}
test('native DSH v3 acceptance, catalog and optional pending owner preserve source facts',{timeout:30000},async t=>{
  const base=await setup(t);const id='native-team-parent';
  const bootstrap=await json(`${base}/api/v3/reader/${provider}/${id}/bootstrap`);
  const doc=await json(`${base}/api/v3/protocol/${provider}/${id}?version=3`);
  assert.equal(doc.validation.ok,true);assert.equal(doc.events.length,13);
  assert.deepEqual(doc.events.map(e=>e.sourceOrder.record),Array.from({length:13},(_,i)=>i));
  const catalog=doc.coordination.find(x=>x.evidence.eventId==='event:dsh:4');
  assert.equal(catalog.kind,'spawn');assert.equal(catalog.state,'started');
  assert.equal(catalog.toSessionRef.sessionId,'native-team-child');
  assert.equal(catalog.evidence.provenance.sourceType,'dsh.session-event:subagent/catalog');
  assert.deepEqual(doc.agentRuns,[]);assert.equal(doc.tasks.length,1);assert.equal(doc.tasks[0].status,'completed');
  const relations=await json(`${base}/api/v3/reader/${provider}/${id}/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
  const task=relations.entries.find(e=>e.type==='task').task;assert.equal(task.owner,'native-team-child');assert.equal(task.provenance.sourceId,'9');
  const placement=relations.childPlacements.find(p=>p.child.sessionId==='native-team-child');assert.equal(placement.sourceEventId,'event:dsh:4');assert.equal(placement.diagnostic,null);assert.equal(placement.afterEvent.messageId,'public-request');
  assert.deepEqual(doc.coordination.filter(x=>['message','mailbox-delivery'].includes(x.kind)).map(x=>x.state),['requested','delivered']);
  assert.ok(doc.events.find(e=>e.id==='event:dsh:1').provenance.sourceType.endsWith('delivery-accepted'));
  assert.equal(doc.events.find(e=>e.id==='event:dsh:10').readerEvent,null,'received mailbox text retains protocol identity without human request authorship');
});
test('native DSH pending task keeps unrecorded owner null',{timeout:30000},async t=>{
  const base=await setup(t,(rows,id)=>{if(id==='native-team-parent'){rows.splice(4);rows.splice(2,1);rows[2].seq=1;}});
  const bootstrap=await json(`${base}/api/v3/reader/${provider}/native-team-parent/bootstrap`);
  const rel=await json(`${base}/api/v3/reader/${provider}/native-team-parent/relations?cursor=${encodeURIComponent(bootstrap.relations.firstCursor)}`);
  assert.equal(rel.entries[0].task.owner,null);assert.equal(Object.hasOwn(rel.entries[0].task,'ownerParticipant'),false);assert.equal(rel.entries[0].task.status,'queued');
});
test('native DSH received mailbox text remains protocol evidence with canonical identity',{timeout:30000},async t=>{
  const base=await setup(t,(rows,id)=>{if(id==='native-team-parent'){const received=rows[11];received.seq=1;rows.splice(2,rows.length-2,received);}});
  const doc=await json(`${base}/api/v3/protocol/${provider}/native-team-parent?version=3`);
  assert.equal(doc.events.length,3);assert.equal(doc.events[2].readerEvent,null);
  const bootstrap=await json(`${base}/api/v3/reader/${provider}/native-team-parent/bootstrap`);
  assert.equal(bootstrap.segments[0].items.length,1);
});
test('native DSH future required event remains an explicit source error',{timeout:30000},async t=>{
  const base=await setup(t,(rows,id)=>{if(id==='native-team-parent')rows[2].type='future/required';});
  const error=await json(`${base}/api/v3/reader/${provider}/native-team-parent/bootstrap`,500);assert.equal(error.error.code,'source_error');assert.match(error.error.message,/unsupported required.*future\/required/);
});
