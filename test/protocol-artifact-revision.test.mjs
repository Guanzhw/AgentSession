import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeSessionProtocol } from '../dist/src/providers/shared/session-protocol.js';
import { upgradeSessionProtocolV2 } from '../dist/src/providers/shared/session-protocol-v3.js';
import { clearProtocolRuntimeCache, getRuntimeProtocol, getRuntimeProtocolSnapshots, getRuntimeProtocolV3 } from '../dist/src/protocol-runtime.js';

for (const surface of ['v2', 'paired', 'native-v3']) {
  test(`${surface} runtime prioritizes session protocol revision without consulting usage revision`, () => {
    clearProtocolRuntimeCache();
    const session = { id: 'root', provider: 'codex', title: 'Fixture', parentId: null, timeCreated: 1, timeUpdated: 2, messageCount: 1, tokenCount: 12 };
    let revision = 'artifact-one';
    let builds = 0;
    let statsReads = 0;
    const build = () => {
      builds++;
      const v2 = finalizeSessionProtocol({ sessionId: 'root', events: [], tasks: [], relationships: [], agentRuns: [], contextArtifacts: [] }, { provider: 'codex', session, revision });
      return { v2, v3: upgradeSessionProtocolV2(v2) };
    };
    const adapter = {
      id: 'codex', getSession: () => session,
      getProtocolRevision(id) { assert.equal(id, 'root'); return revision; },
      getStatsRevision() { statsReads++; return 'unchanged-usage'; },
      getSessionProtocol: () => build().v2,
      ...(surface === 'paired' ? { getSessionProtocolSnapshots: build } : {}),
      ...(surface === 'native-v3' ? { getSessionProtocolV3: () => build().v3 } : {})
    };
    const read = () => surface === 'v2' ? getRuntimeProtocol(adapter, 'root')
      : surface === 'paired' ? getRuntimeProtocolSnapshots(adapter, 'root') : getRuntimeProtocolV3(adapter, 'root');
    const first = read();
    assert.deepEqual(read(), first);
    assert.equal(builds, 1);
    revision = 'artifact-two';
    const next = read();
    assert.equal(builds, 2);
    assert.equal((surface === 'paired' ? next.v2 : next).revision.value, revision);
    assert.equal(statsReads, 0);
  });
}
