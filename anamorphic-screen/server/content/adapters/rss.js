import { parseMarkup, descendants, textOf } from './markup.js';
export function parseRSS(source, index = 0) {
  const root = parseMarkup(source, { xml: true });
  const items = descendants(root).filter(node => ['item', 'entry'].includes(node.tag.split(':').at(-1)));
  if (!Number.isInteger(index) || index < 0 || !items[index]) throw new Error('Không tìm thấy mục RSS / Atom đã chọn.');
  const result = Object.create(null);
  for (const child of items[index].children) {
    if (typeof child === 'string') continue;
    const local = child.tag.split(':').at(-1);
    let value = textOf(child);
    if (['description', 'summary', 'content', 'encoded'].includes(local)) value = textOf(parseMarkup(value));
    if (local === 'link') {
      if (child.attrs.rel === 'enclosure') { result.enclosure = child.attrs.href || ''; continue; }
      if (child.attrs.rel && child.attrs.rel !== 'alternate') continue;
      value = child.attrs.href || value;
    }
    if (['enclosure', 'thumbnail', 'image'].includes(local) || child.tag === 'media:content') value = child.attrs.url || child.attrs.href || value;
    result[child.tag] = value; result[local] = value;
  }
  // Common poster mapping also works with Atom's summary/content and updated.
  result.description ??= result.summary || result.content || '';
  result.pubdate ??= result.published || result.updated || '';
  return result;
}
