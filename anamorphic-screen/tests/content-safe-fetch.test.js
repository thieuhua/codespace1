import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIP, safeFetch, MAX_BODY } from '../server/content/safe-fetch.js';

const publicDNS = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status = 200, headers = { 'content-type': 'application/json' }, body = '{}') => ({ status, headers, body: Buffer.from(body) });

test('IP classification blocks private, CGNAT, metadata, mapped IPv4 and non-global IPv6', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '168.63.129.16', '172.16.0.1', '172.31.255.255', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::', 'bad']) assert.equal(isBlockedIP(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isBlockedIP(ip), false, ip);
});

test('safe fetch pins a checked DNS address and resolves every redirect hop', async () => {
  const lookups = [], requests = [];
  const resolver = async host => { lookups.push(host); return publicDNS(); };
  const request = async value => {
    requests.push(value);
    return requests.length === 1 ? response(302, { location: '/next' }) : response(200, { 'content-type': 'application/problem+json; charset=utf-8' });
  };
  assert.equal((await safeFetch('https://example.com/start', { resolver, request })).url, 'https://example.com/next');
  assert.deepEqual(lookups, ['example.com', 'example.com']);
  assert.equal(requests[0].address, '93.184.216.34');
  assert.equal(requests[0].family, 4);
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.equal(requests[0].maxBytes, MAX_BODY);
});

test('redirects recheck DNS, port, protocol and allow-host exceptions at each hop', async () => {
  for (const target of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'https://public.example:444/', 'file:///etc/passwd', 'http://user:pass@public.example/']) {
    let calls = 0;
    await assert.rejects(safeFetch('https://example.com', { resolver: publicDNS, request: async () => { calls++; return response(302, { location: target }); } }));
    assert.equal(calls, 1, target);
  }
  let dns = 0, calls = 0;
  await assert.rejects(safeFetch('https://example.com', {
    resolver: async () => [{ address: ++dns === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    request: async () => { calls++; return response(302, { location: '/again' }); }
  }), /mạng riêng/);
  assert.equal(calls, 1);
  await assert.rejects(safeFetch('http://lan.test', { resolver: async () => [{ address: '192.168.1.5' }], allowHosts: ['other.test'], request: async () => assert.fail('private request') }));
  assert.equal((await safeFetch('http://lan.test:8080', { resolver: async () => [{ address: '192.168.1.5' }], allowHosts: ['lan.test'], ports: [8080], request: async value => { assert.equal(value.address, '192.168.1.5'); return response(); } })).body, '{}');
  await assert.rejects(safeFetch('http://lan.test', { resolver: async () => [{ address: '192.168.1.5' }], allowHosts: ['lan.test'], request: async () => response(302, { location: 'http://127.0.0.1' }) }));
});

test('safe fetch bounds redirects, body, MIME types, mixed DNS and origin-bound headers', async () => {
  const options = { resolver: publicDNS };
  let calls = 0;
  await assert.rejects(safeFetch('https://example.com', { ...options, request: async () => { calls++; return response(302, { location: '/loop' }); } }), /3 lần/);
  assert.equal(calls, 4);
  for (const result of [response(500), response(200, { 'content-type': 'text/html' }), response(200, {}, '{}'), response(200, { 'content-type': 'application/json' }, Buffer.alloc(MAX_BODY + 1))]) {
    await assert.rejects(safeFetch('https://example.com', { ...options, request: async () => result }));
  }
  await assert.rejects(safeFetch('https://example.com', { resolver: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }], request: async () => assert.fail('mixed DNS request') }));
  calls = 0;
  await assert.rejects(safeFetch('https://example.com', { ...options, headers: { Authorization: 'secret' }, request: async () => { calls++; return response(302, { location: 'https://other.example/' }); } }), /origin/);
  assert.equal(calls, 1);
});

test('deadline also bounds DNS; an expired resolution must never start a request', async () => {
  let resolveDNS;
  await assert.rejects(safeFetch('https://example.com', { timeout: 5, resolver: () => new Promise(resolve => { resolveDNS = resolve; }), request: async () => assert.fail('late request') }), /8 giây/);
  resolveDNS(await publicDNS());
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(safeFetch('https://example.com', { signal: AbortSignal.abort(), resolver: async () => assert.fail('aborted DNS') }), /dừng/);
});
