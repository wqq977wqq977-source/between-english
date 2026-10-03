import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchArticle, validateRemoteURL } from '../server/article.mjs';

function mockDNS(t, implementation) {
  const original = dns.lookup;
  dns.lookup = implementation;
  syncBuiltinESMExports();
  t.after(() => { dns.lookup = original; syncBuiltinESMExports(); });
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Article did not stop while DNS was pending')), 750);
    })]);
  } finally { clearTimeout(timer); }
}

test('an already cancelled article never starts a DNS lookup', async t => {
  let lookups = 0;
  mockDNS(t, async () => { lookups++; throw new Error('DNS must not start'); });
  await assert.rejects(fetchArticle('https://article.example/reading', AbortSignal.abort()), { status: 409 });
  assert.equal(lookups, 0);
});

test('cancelling an article releases its task before DNS finishes and handles a late rejection', async t => {
  let rejectDNS;
  mockDNS(t, () => new Promise((_, reject) => { rejectDNS = reject; }));
  const controller = new AbortController();
  const pending = fetchArticle('https://article.example/reading', controller.signal);
  try {
    controller.abort();
    await assert.rejects(bounded(pending), { status: 409 });
  } finally {
    rejectDNS(new Error('Late DNS failure'));
    await pending.catch(() => {});
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('a DNS wait observes a deadline and removes its abort listener', async t => {
  let resolveDNS;
  mockDNS(t, () => new Promise(resolve => { resolveDNS = resolve; }));
  const signal = AbortSignal.timeout(20);
  const pending = validateRemoteURL('https://article.example/reading', signal);
  try {
    await assert.rejects(bounded(pending), { name: 'TimeoutError' });
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  } finally {
    resolveDNS([{ address: '1.1.1.1', family: 4 }]);
    await pending.catch(() => {});
  }
});

test('the overall article deadline also covers pending DNS', async t => {
  let rejectDNS;
  mockDNS(t, () => new Promise((_, reject) => { rejectDNS = reject; }));
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 45000);
    return timeout.call(AbortSignal, 20);
  });
  const pending = fetchArticle('https://article.example/reading');
  try {
    await assert.rejects(bounded(pending), { status: 504 });
  } finally {
    rejectDNS(new Error('Late DNS failure'));
    await pending.catch(() => {});
  }
});

test('settled DNS lookups remove listeners and still reject private addresses', async t => {
  let outcome = [{ address: '1.1.1.1', family: 4 }];
  mockDNS(t, async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  const controller = new AbortController();
  const result = await validateRemoteURL('https://article.example/reading', controller.signal);
  assert.deepEqual(result.address, outcome[0]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  outcome = [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(validateRemoteURL('https://article.example/reading', controller.signal), { status: 400 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  outcome = new Error('DNS failed');
  await assert.rejects(validateRemoteURL('https://article.example/reading', controller.signal), /DNS failed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful article download pins the validated DNS address', async t => {
  let lookups = 0;
  mockDNS(t, async () => { lookups++; return [{ address: '1.1.1.1', family: 4 }]; });
  const paragraph = 'The Moon reflects sunlight and travels around the Earth. Scientists study its surface to learn about the history of the solar system. Each mission helps people understand our nearest neighbour in space.';
  t.mock.method(https, 'get', (_url, options, onResponse) => {
    assert.equal(options.agent, false);
    options.lookup('article.example', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
    });
    options.lookup('article.example', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '1.1.1.1');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html' };
      onResponse(response);
      response.end(`<html><head><title>The Moon</title></head><body><article><p>${paragraph}</p><p>${paragraph} New observations raise new questions.</p></article></body></html>`);
    });
    return request;
  });
  const article = await fetchArticle('https://article.example/reading');
  assert.equal(lookups, 1);
  assert.ok(article.text.includes(paragraph));
});

test('synthetic DNS fallback still validates the public resolver answer', async t => {
  mockDNS(t, async () => [{ address: '198.18.0.1', family: 4 }]);
  let address = '1.1.1.1';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://cloudflare-dns.com/dns-query?name=article.example&type=A');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ Answer: [{ type: 1, data: address }] }) };
  });
  assert.deepEqual((await validateRemoteURL('https://article.example/reading')).address, { address, family: 4 });
  address = '127.0.0.1';
  await assert.rejects(validateRemoteURL('https://article.example/reading'), { status: 400 });
});
