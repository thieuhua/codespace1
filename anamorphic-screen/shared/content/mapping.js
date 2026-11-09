import { normalizeFields, validateFieldMap } from './schema.js';

export function jsonPointer(data, pointer) {
  if (pointer === '') return data;
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('JSON Pointer phải bắt đầu bằng / và chỉ dùng ~0, ~1 để thoát.');
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Không được đọc prototype.');
    if (data === null || typeof data !== 'object' || !Object.hasOwn(data, key)) return '';
    data = data[key];
  }
  return data;
}
export function formatValue(value, formatters = []) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  for (const formatter of formatters) {
    if (formatter === 'trim') value = String(value).trim();
    else if (formatter === 'upper') value = String(value).toLocaleUpperCase('vi-VN');
    else if (formatter === 'date') { const date = new Date(value); value = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('vi-VN', { timeZone: 'UTC' }); }
    else if (formatter === 'number') value = String(value).trim() && Number.isFinite(Number(value)) ? new Intl.NumberFormat('vi-VN').format(Number(value)) : '';
    else throw new Error('Bộ định dạng không được hỗ trợ.');
  }
  return value;
}
export function mapFields(data, mapping, { kind = 'json', extract, baseURL } = {}) {
  const fieldMap = validateFieldMap(mapping), fields = {};
  for (const [name, spec] of Object.entries(fieldMap)) {
    let value;
    if (kind === 'html') value = extract(data, spec.source, spec.attribute);
    else if (kind === 'rss') value = data && Object.hasOwn(data, spec.source.toLowerCase()) ? data[spec.source.toLowerCase()] : '';
    else value = jsonPointer(data, spec.source);
    fields[name] = formatValue(value, spec.formatters);
  }
  return normalizeFields(fields, fieldMap, baseURL);
}

function simple(selector) {
  const match = selector.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)(?:\[([\w:-]+)(?:=["']?([\w:/.-]+)["']?)?\])?$/);
  if (!match || !selector || selector === '*') throw new Error('Chỉ hỗ trợ tag, #id, .class, [thuộc-tính], hậu duệ và >.');
  const parts = [...match[2].matchAll(/([.#])([\w-]+)/g)];
  return node => (!match[1] || match[1] === '*' || node.tag === match[1].toLowerCase()) && parts.every(([, kind, value]) => kind === '#' ? node.attrs.id === value : (node.attrs.class || '').split(/\s+/).includes(value)) && (!match[3] || Object.hasOwn(node.attrs, match[3]) && (match[4] === undefined || node.attrs[match[3]] === match[4]));
}
export function selectorSteps(selector) {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  if (tokens.length > 12 || !selector.trim()) throw new Error('Selector quá dài hoặc trống.');
  const steps = []; let direct = false;
  for (const token of tokens) {
    if (token === '>') { if (!steps.length || direct) throw new Error('Selector > không hợp lệ.'); direct = true; }
    else { steps.push({ matches: simple(token), direct }); direct = false; }
  }
  if (direct) throw new Error('Selector > thiếu phần tử.');
  return steps;
}
