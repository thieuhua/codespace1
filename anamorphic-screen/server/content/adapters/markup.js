const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©' };
export function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? match;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
  });
}
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export function parseMarkup(input, { xml = false } = {}) {
  if (input.length > 2 * 1024 * 1024 || xml && /<!\s*(DOCTYPE|ENTITY)/i.test(input)) throw new Error('Tài liệu quá lớn hoặc chứa khai báo XML không hỗ trợ.');
  const root = { tag: '', attrs: {}, children: [] }, stack = [root];
  let count = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|<![^>]*>|[^<]+|</g;
  for (const token of input.matchAll(tokens)) {
    if (++count > 50000) throw new Error('Tài liệu có quá nhiều phần tử.');
    const text = token[0], parent = stack.at(-1);
    if (!xml && ['script', 'style'].includes(parent.tag) && !new RegExp(`^</${parent.tag}\\s*>$`, 'i').test(text)) continue;
    if (text.startsWith('<!--') || text.startsWith('<!') && !text.startsWith('<![CDATA[')) continue;
    if (text.startsWith('<![CDATA[')) { parent.children.push(text.slice(9, -3)); continue; }
    if (text.startsWith('</')) {
      const tag = text.slice(2).match(/^[\w:-]+/)?.[0].toLowerCase();
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index > 0) stack.length = index;
    } else if (/^<[a-z]/i.test(text)) {
      const tag = text.slice(1).match(/^[\w:-]+/)[0].toLowerCase(), attrs = Object.create(null);
      const source = text.slice(tag.length + 1, -1);
      for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
      const node = { tag, attrs, children: [], parent };
      parent.children.push(node);
      if (!text.endsWith('/>') && (xml || !voidTags.has(tag))) stack.push(node);
      if (stack.length > 128) throw new Error('Tài liệu lồng quá sâu.');
    } else parent.children.push(decodeEntities(text));
  }
  return root;
}
export function descendants(node) {
  const result = [];
  for (const child of node.children) if (typeof child !== 'string') { result.push(child, ...descendants(child)); }
  return result;
}
export function textOf(node) {
  if (typeof node === 'string') return node;
  if (['script', 'style', 'template', 'noscript'].includes(node.tag)) return '';
  return node.children.map(child => typeof child === 'object' && ['br', 'p', 'div', 'li'].includes(child.tag) ? ` ${textOf(child)} ` : textOf(child)).join('').replace(/\s+/g, ' ').trim();
}
