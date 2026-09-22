import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReaderMemberRails } from '../dist/src/views/reader-member-rails.js';
import { setLocale } from '../dist/src/i18n.js';

const fixture = (name = 'Writer') => ({
  lanes: [], unplaced: [],
  milestones: [{ id:'obs:<create>', sourceEventRef:{ session:{ provider:'fixture', sessionId:'root/a' }, eventId:'event:1' } }],
  memberRails: {
    members: [{ id:'session:fixture:child', name, purpose:null, childSession:{ provider:'fixture', sessionId:'child' }, color:0 }],
    points:[{ id:'obs:<create>', from:'main', to:'session:fixture:child', kind:'spawn', state:'started', sequence:1 }],
    edges:[{ id:'obs:<create>', from:'main', to:'session:fixture:child', start:'obs:<create>', end:'obs:<create>', kind:'create', received:false }]
  }
});

test('rail payload retains canonical point anchors and owner without an extra main member', () => {
  const html = renderReaderMemberRails(fixture());
  const payload = JSON.parse(html.match(/data-reader-member-rails-data>(.*?)<\/script>/s)[1]);
  assert.equal(payload.points[0].anchor, 'milestone-obs--create-');
  assert.equal(payload.points[0].kind, 'spawn');
  assert.deepEqual(payload.owner, {provider:'fixture', sessionId:'root/a'});
  assert.equal(payload.members.length, 1);
  assert.match(html, /data-reader-member-rails-controls hidden/);
});

test('untrusted member names stay data in JSON and escaped text in controls', () => {
  const name = '</script><img src=x onerror="alert(1)">&';
  const html = renderReaderMemberRails(fixture(name));
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(JSON.parse(html.match(/data-reader-member-rails-data>(.*?)<\/script>/s)[1]).members[0].name, name);
});

test('empty projections do not add controls or reserve a rail region', () => {
  assert.equal(renderReaderMemberRails({lanes:[],milestones:[],unplaced:[]}), '');
  assert.equal(renderReaderMemberRails({...fixture(), memberRails:{members:[],points:[],edges:[]}}), '');
});

test('rail controls use the active locale', () => {
  for (const locale of ['en','zh']) {
    setLocale(locale);
    const html = renderReaderMemberRails(fixture());
    assert.doesNotMatch(html, /detail\.reader_member_rails_/);
  }
  setLocale('en');
});
