import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { UserError } from './contracts.mjs';

export function publicIP(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (family === 6) return /^2[0-9a-f]{3}:/i.test(ip) && !/^2001:(?:0:|db8:)/i.test(ip) && !/^2002:/i.test(ip);
  return false;
}
async function lookupWithSignal(host, signal) {
  signal?.throwIfAborted();
  if (!signal) return lookup(host, { all: true, verbatim: true });
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // System DNS cannot be cancelled, but it must not hold up the task queue.
    // Promise.race also handles a lookup rejection arriving after cancellation.
    return await Promise.race([lookup(host, { all: true, verbatim: true }), cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function validateRemoteURL(value, signal) {
  signal?.throwIfAborted();
  let url; try { url = new URL(value); } catch { throw new UserError('请输入完整的文章网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new UserError('仅支持常规 HTTP/HTTPS 文章链接。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupWithSignal(host, signal);
  // Some local proxy clients return benchmarking-range synthetic DNS addresses.
  // Resolve through a fixed authenticated public resolver; never allow that range.
  if (!isIP(host) && addresses.length && addresses.every(a => /^198\.(18|19)\./.test(a.address))) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new UserError('公开域名解析暂时失败，请稍后重试。', 502);
    const answer = await response.json();
    addresses = (answer.Answer || []).filter(a => a.type === 1).map(a => ({ address: a.data, family: 4 }));
  }
  if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new UserError('该地址无法作为公开文章来源。');
  return { url, address: addresses[0] };
}
async function download(value, signal, redirects = 0) {
  if (redirects > 4) throw new UserError('文章跳转次数过多，请导入正文。', 422);
  const { url, address } = await validateRemoteURL(value, signal);
  const response = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, {
      signal, agent: false, timeout: 18000,
      headers: { 'User-Agent': 'Between-English/0.1 (personal reading)', Accept: 'text/html, text/plain;q=0.9', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family)
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        try { if (!res.headers.location) throw new Error('missing redirect'); resolve({ redirect: new URL(res.headers.location, url).href }); }
        catch { reject(new UserError('文章来源返回了无效跳转，请使用其他链接或导入正文。', 422)); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new UserError('来源网站暂时无法读取正文。可以打开原文后导入文本。', 422)); return; }
      if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(res.headers['content-type'] || '')) { res.resume(); reject(new UserError('这个链接不是可阅读的网页文本，请导入正文。', 422)); return; }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.resume(); reject(new UserError('来源网站的正文格式暂不支持，请导入文本。', 422)); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2500000) req.destroy(new UserError('文章页面过大，请导入需要学习的段落。', 422)); else chunks.push(chunk); });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: url.href }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new UserError('读取原文超时，请稍后重试或导入文本。', 504)));
    req.on('error', reject);
  });
  return response.redirect ? download(response.redirect, signal, redirects + 1) : response;
}
function removeRecommendations(document) {
  const normalize = text => text.replace(/\s+/g, ' ').trim().replace(/[:：]\s*$/, '');
  const recommendation = /^(?:additional resources|related (?:articles|posts|stories|resources|content)(?: for (?:educators|teachers))?|read next|you (?:may|might) also like|recommended (?:articles|reading)|further reading|interested in learning more(?: about .{1,100})?\??)$/i;
  const isRecommendationBlock = node => {
    if (node.nodeType !== 1) return false;
    return [node, ...node.querySelectorAll('p,li,div')].some(block => {
      const links = block.matches('a[href]') ? [block] : [...block.querySelectorAll('a[href]')];
      const linkedLength = links.filter(link => !link.getAttribute('href').startsWith('#'))
        .reduce((length, link) => length + normalize(link.textContent).length, 0);
      const length = normalize(block.textContent).length;
      return length > 0 && linkedLength / length >= 0.8;
    });
  };
  for (const heading of document.querySelectorAll('h2,h3,h4,h5,h6')) {
    if (!heading.isConnected || !recommendation.test(normalize(heading.textContent))) continue;
    const level = Number(heading.nodeName.slice(1));
    const boundary = Array.from({ length: level }, (_, i) => `h${i + 1}`).join(',');
    let start = heading;
    // Publishers sometimes wrap only the heading, leaving the links as siblings.
    while (start.parentElement && start.parentElement.children.length === 1
      && normalize(start.parentElement.textContent) === normalize(heading.textContent)) start = start.parentElement;
    const section = [];
    for (let node = start.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === 1 && (node.matches(boundary) || node.querySelector(boundary))) break;
      section.push(node);
    }
    // A label or an inline citation is ambiguous. Require link-dominated blocks
    // and stop at the next peer/parent heading rather than truncating the article.
    if (!section.some(isRecommendationBlock)) continue;
    start.remove();
    for (const node of section) node.remove();
  }
}

export function extractArticle(html, url) {
  const { document } = parseHTML(html);
  const parsed = new Readability(document, { charThreshold: 200 }).parse();
  if (!parsed?.content) throw new UserError('没有找到完整正文，请打开来源网站后导入文本。', 422);
  const clean = parseHTML(parsed.content).document;
  removeRecommendations(clean);
  const paragraphs = []; let current = '';
  const flush = () => { const line = current.replace(/\s+/g, ' ').trim(); if (line && paragraphs.at(-1) !== line) paragraphs.push(line); current = ''; };
  const walk = node => {
    if (node.nodeType === 3) { current += node.textContent; return; }
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|BUTTON|FORM)$/.test(node.nodeName)) return;
    const block = /^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|UL|OL|BLOCKQUOTE|FIGCAPTION|BR|TABLE|TR)$/.test(node.nodeName);
    if (block) flush();
    for (const child of node.childNodes || []) walk(child);
    if (block) flush();
  };
  walk(clean); flush();
  const text = paragraphs.join('\n\n');
  if (text.length < 250 || /^(access denied|just a moment|verify you are human)/i.test(parsed.title || '')) throw new UserError('来源网站没有返回可用正文，请导入文章文本。', 422);
  if (text.length > 90000) throw new UserError('文章过长，请导入需要学习的部分。', 422);
  return { title: parsed.title || new URL(url).hostname, text, wordCount: text.split(/\s+/).length, byline: parsed.byline || '', url };
}
export async function fetchArticle(url, signal) {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  try { const page = await download(url, deadline); return extractArticle(page.html, page.url); }
  catch (e) {
    if (signal?.aborted) throw new UserError('任务已取消。', 409);
    if (deadline.aborted) throw new UserError('读取原文超时，请稍后重试或导入文本。', 504);
    if (e instanceof UserError) throw e;
    throw new UserError('暂时无法获取原文。请检查网络，或使用“导入文章”。', 422);
  }
}
