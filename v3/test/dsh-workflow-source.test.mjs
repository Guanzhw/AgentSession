import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,cp,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import test from 'node:test';
import {freeFetchSafePort} from './fetch-safe-port.mjs';
const repo=path.resolve(import.meta.dirname,'../..');
const binary=process.env.AGENTSESSION_V3_BIN||path.join(repo,'v3/target/debug',process.platform==='win32'?'agentsession-v3.exe':'agentsession-v3');
const fixture=path.join(repo,'v3/fixtures/deepseek-harness-v4-workflow');
const session={provider:'deepseek-harness',sessionId:'dsh-v4-workflow'};
const digest=b=>createHash('sha256').update(b).digest('hex');

test('current DSH required workflow run records remain raw source facts over native Web and MCP', {timeout:30000}, async t=>{
  const work=await mkdtemp(path.join(repo,'tmp/dsh-workflow-'));
  const source=path.join(fixture,'sessions/public/dsh-v4-workflow/session.v4.jsonl');
  const before=digest(await readFile(source));
  const raw=(await readFile(source,'utf8')).trim().split('\n').map(JSON.parse);
  await cp(fixture,path.join(work,'dsh'),{recursive:true});
  for(const name of ['codex','claude','pi','meta','index','cache'])await mkdir(path.join(work,name));
  await writeFile(path.join(work,'config.json'),'{}');
  const args=['--config',path.join(work,'config.json'),'--dsh-dir',path.join(work,'dsh'),'--opencode-db',path.join(work,'missing.db'),...['codex','claude','pi','meta','index','cache'].flatMap(name=>[`--${name}-dir`,path.join(work,name)])];
  const port=await freeFetchSafePort();
  const child=spawn(binary,['serve','--port',String(port),'--disable-terminal-launch',...args],{cwd:repo,windowsHide:true,stdio:['ignore','ignore','pipe']});
  const closed=once(child,'close');let client;
  t.after(async()=>{if(client)await client.close();child.kill();await closed;assert.equal(digest(await readFile(source)),before);await rm(work,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<200;i++){try{if((await fetch(base+'/api/providers')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  async function get(suffix){const response=await fetch(base+suffix),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;}
  const reader=await get(`/api/v3/reader/${session.provider}/${session.sessionId}/bootstrap`);
  const protocol=await get(`/api/v3/protocol/${session.provider}/${session.sessionId}?version=3`);
  assert.equal(protocol.validation.ok,true);
  assert.deepEqual(protocol.agentRuns,[]);
  assert.deepEqual(protocol.tasks,[]);
  assert.deepEqual(protocol.coordination,[]);
  assert.deepEqual(protocol.events.map(e=>[e.id,e.sourceOrder.record,e.timestamp,e.provenance.sourceType]),raw.map((r,index)=>[index===0?'event:dsh:header':`event:dsh:${r.seq}`,index===0?0:r.seq+1,index===0?r.createdAt:r.time,index===0?'dsh.session.header':`dsh.session-event:${r.type}`]));
  for(const seq of [1,2]){const event=protocol.events.find(e=>e.id===`event:dsh:${seq}`);assert.equal(event.readerEvent,null);assert.equal(event.execution,undefined);assert.equal(event.provenance.fidelity,'recorded');}
  assert.deepEqual(reader.segments.flatMap(s=>s.items).filter(i=>i.event.segment==='message').map(i=>i.event.messageId),['workflow-request','workflow-response']);
  client=new Client({name:'dsh-workflow-source-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:binary,args:['mcp',...args],cwd:repo,stderr:'pipe'}));
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,r.content?.[0]?.text);return r.structuredContent.result;};
  const timeline=[];let cursor;do{const page=await call('session_timeline',{session,limit:1,...(cursor?{cursor}:{})});timeline.push(...page.events);cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(timeline.map(e=>e.event.messageId),['workflow-request','workflow-response']);
  const response=await call('session_get_event',{event:timeline[1].event,maxChars:100});
  assert.equal(response.content.text,raw[4].data.message.content[0].text);
});
