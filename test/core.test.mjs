import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filters, reviewSchedule, schemas, validateShape, sourceURL, mergeWordRecord } from '../server/contracts.mjs';
import { parseEvent } from '../server/codex.mjs';
import { publicIP, validateRemoteURL, extractArticle } from '../server/article.mjs';
import { openStore } from '../server/db.mjs';

test('reject invalid counts and inverted article length before model invocation', () => {
  for (const count of [0,-1,101,2.5,'abc']) assert.throws(()=>filters('words',{count}));
  assert.throws(()=>filters('articles',{minWords:900,maxWords:100}));
  assert.equal(filters('words',{count:5}).count,5);
});
test('review scheduling preserves mastery streak and resets after failure',()=>{
  const base=Date.parse('2026-10-01T00:00:00Z');
  const known=reviewSchedule(null,'known',base);
  assert.equal(Date.parse(known.dueAt)-base,2*86400000);
  assert.equal(reviewSchedule(known,'known',base).streak,2);
  const forgotten=reviewSchedule(known,'unknown',base);
  assert.equal(forgotten.streak,0);assert.equal(Date.parse(forgotten.dueAt)-base,600000);
  assert.throws(()=>reviewSchedule(null,'bad',base));
});
test('only completed search actions count as evidence, retaining source URLs',()=>{
  const evidence=[];
  parseEvent({type:'item.started',item:{type:'web_search',action:{type:'search'}}},evidence);
  parseEvent({type:'item.completed',item:{type:'web_search',action:{type:'open_page'}}},evidence);
  assert.equal(evidence.length,0);
  parseEvent({type:'item.completed',item:{type:'web_search',action:{type:'search',query:'moon'},results:[{url:'https://nasa.gov/moon',title:'Moon'}]}},evidence);
  assert.equal(evidence.length,1);assert.equal(evidence[0].sources[0].url,'https://nasa.gov/moon');
});
test('model shape rejects incomplete output, arrays and oversized strings',()=>{
  assert.throws(()=>validateShape({ok:true},schemas.connection));
  assert.throws(()=>validateShape({ok:'true',message:'hi'},schemas.connection));
  assert.throws(()=>validateShape({ok:true,message:'x'.repeat(20001)},schemas.connection));
  assert.deepEqual(validateShape({ok:true,message:'yes'},schemas.connection),{ok:true,message:'yes'});
});
test('public article requests exclude local/private/reserved addresses',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.0.1','172.17.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicIP(ip),false,ip);
  assert.equal(publicIP('1.1.1.1'),true);assert.equal(publicIP('2606:4700:4700::1111'),true);
  for(const url of ['http://127.0.0.1','http://[::1]','http://2130706433','http://0x7f000001','file:///etc/passwd','https://user:password@example.org','http://example.org:8080'])await assert.rejects(validateRemoteURL(url));
  assert.equal(sourceURL('javascript:alert(1)'),'');
});
test('article extraction strips scripts and keeps paragraph text',()=>{
  const paragraphs=['The Moon is our nearest neighbour in space. It circles Earth and reflects sunlight. People have observed its changing shape for thousands of years.', 'A spacecraft carries instruments that help scientists study distant places. It can take photographs and send information back to Earth for careful study.', 'Learning about the Moon helps us understand our own planet. Each mission asks new questions about rocks, water, and the history of the solar system.'];
  const result=extractArticle(`<html><head><title>Exploring the Moon</title></head><body><article><h1>Exploring the Moon</h1>${paragraphs.map(p=>`<p>${p}</p>`).join('')}<script>alert('bad')</script></article></body></html>`,'https://example.com/moon');
  assert.ok(result.text.includes(paragraphs[0]));assert.ok(!result.text.includes('alert'));assert.ok(result.wordCount>50);
});
test('saved study records survive reopening; transactions roll back together',()=>{
  const dir=mkdtempSync(join(tmpdir(),'between-test-'));let store=openStore(dir);
  try{store.put('word',{id:'word:moon',word:'moon',review:{rating:'known'}});assert.throws(()=>store.transaction(()=>{store.put('word',{id:'word:earth',word:'earth'});throw new Error('rollback');}));assert.equal(store.get('word:earth'),null);store.close();store=openStore(dir);assert.equal(store.get('word:moon').review.rating,'known');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('new searches preserve saved article context and review history',()=>{
  const original=mergeWordRecord(null,{word:'Moon',meaning:'月球',example:'The Moon is bright.',exampleTranslation:'月亮很亮。'},{articleId:'a1',articleTitle:'Moon',sourceUrl:'https://example.org/moon'});
  original.review={rating:'known',streak:3};
  const searched=mergeWordRecord(original,{word:'moon',meaning:'月亮',example:'A newly generated example.',exampleTranslation:'新的例句',sourceUrl:'https://example.org/dictionary'});
  assert.equal(searched.example,'The Moon is bright.');assert.equal(searched.sourceUrl,'https://example.org/moon');assert.equal(searched.articleId,'a1');assert.equal(searched.review.streak,3);assert.equal(searched.contexts.length,1);
  const second=mergeWordRecord(searched,{word:'moon',meaning:'月球',example:'We see the moon.'},{articleId:'a2'});assert.equal(second.contexts.length,2);
});
test('nested publisher markup preserves block boundaries without duplication',()=>{
  const first='The Moon reflects light from the Sun. Scientists can measure its orbit carefully and use the information to understand the solar system.';
  const second='People on Earth see the Moon from changing angles. That is why the illuminated part appears to change over the course of a month.';
  const result=extractArticle(`<html><body><article><div><p>${first}<div><p>${second}</p></div></p></div><p>${first} It takes time to study.</p></article></body></html>`,'https://example.org/moon');
  assert.ok(result.text.includes(first+'\n\n'+second));
});
