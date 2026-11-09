import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { sourceURL } from '../../shared/content/schema.js';

export const MAX_BODY = 2 * 1024 * 1024;
const blocked = new BlockList(), globalV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure platform/metadata services.
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(address, prefix, 'ipv6');
export function isBlockedIP(address) {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  // Only global unicast; this also rejects mapped/compatible IPv4, ULA, NAT64,
  // loopback, link-local, multicast and unspecified addresses without text heuristics.
  return family !== 6 || !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6');
}
const hostname = value => value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
function failure(message) { return Object.assign(new Error(message), { status: 400 }); }
function transport({ url, address, family, signal, headers, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, headers: { Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      agent: false, autoSelectFamily: false, family,
      lookup: (_host, options, callback) => callback(null, options.all ? [{ address, family }] : address, family)
    }, response => {
      const status = response.statusCode, responseHeaders = response.headers;
      if ([301, 302, 303, 307, 308].includes(status)) { response.destroy(); resolve({ status, headers: responseHeaders, body: Buffer.alloc(0) }); return; }
      if (Number(responseHeaders['content-length']) > maxBytes || responseHeaders['content-encoding'] && responseHeaders['content-encoding'] !== 'identity') {
        response.destroy(); reject(failure('Nguồn quá lớn hoặc dùng nén không được hỗ trợ.')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); reject(failure('Nội dung vượt 2 MiB.')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject); request.end();
  });
}
export async function safeFetch(input, { resolver = host => lookup(host, { all: true }), request = transport,
  allowHosts = (process.env.CONTENT_ALLOW_HOSTS || '').split(',').filter(Boolean),
  ports = (process.env.CONTENT_ALLOW_PORTS || '80,443').split(',').map(Number),
  types = ['application/json'], headers = {}, signal, timeout = 8000, maxBytes = MAX_BODY } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('Nguồn không phản hồi trong 8 giây.')); }, timeout); });
  const run = async () => {
    let url = new URL(sourceURL(input));
    const initialOrigin = url.origin;
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) throw failure('Đã dừng lấy nguồn.');
      sourceURL(url.href);
      if (!ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw failure('Cổng nguồn không nằm trong danh sách cho phép.');
      const host = hostname(url.hostname), trusted = allowHosts.some(h => hostname(h.trim()) === host);
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
      if (controller.signal.aborted) throw failure('Đã dừng lấy nguồn.');
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isIP(item.address) || !trusted && isBlockedIP(item.address))) throw failure('Địa chỉ nguồn thuộc mạng riêng hoặc dải bị chặn.');
      if (Object.keys(headers).length && url.origin !== initialOrigin) throw failure('Nguồn có khóa không được chuyển hướng sang origin khác.');
      const pinned = addresses[0];
      const response = await request({ url, address: pinned.address, family: isIP(pinned.address), signal: controller.signal, headers, maxBytes });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 3 || !response.headers.location) throw failure('Nguồn chuyển hướng quá 3 lần hoặc thiếu đích.');
        url = new URL(response.headers.location, url); continue;
      }
      if (response.status < 200 || response.status >= 300) throw failure(`Nguồn trả HTTP ${response.status}.`);
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!types.includes(type) && !(types.includes('application/json') && /^application\/[\w.+-]+\+json$/.test(type))) throw failure('Content-Type nguồn không đúng định dạng đã chọn.');
      const body = Buffer.from(response.body);
      if (body.length > maxBytes) throw failure('Nội dung vượt 2 MiB.');
      return { body: body.toString('utf8'), url: url.href, contentType: type };
    }
  };
  try { return await Promise.race([run(), deadline]); }
  catch (error) { if (error.status) throw error; throw failure('Không đọc được nguồn công khai. Kiểm tra URL, DNS, TLS và kết nối.'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
