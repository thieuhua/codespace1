export const FIELD_TYPES = { text: 2000, multiline: 10000, imageUrl: 2048 };
export const FORMATTERS = ['trim', 'upper', 'date', 'number'];
export const TEMPLATES = { poster: 'Áp phích', fields: 'Danh sách trường', ticker: 'Chữ lớn' };
export const ADAPTERS = {
  manual: { label: 'Nhập tay', inputs: [] },
  json: { label: 'JSON', inputs: ['url', 'proxy', 'interval', 'secretRef'] },
  websocket: { label: 'WebSocket JSON', inputs: ['url'] },
  clock: { label: 'Đồng hồ / ngày', inputs: [] },
  rss: { label: 'RSS / Atom (qua server)', inputs: ['url', 'interval', 'item', 'secretRef'] },
  html: { label: 'HTML tĩnh (qua server)', inputs: ['url', 'interval', 'secretRef'] },
  iframe: { label: 'Trang nhúng (không canvas 2×)', inputs: ['url'] }
};
export const INPUTS = {
  url: { label: 'URL công khai', type: 'url' }, proxy: { label: 'Lấy qua server', type: 'checkbox' },
  interval: { label: 'Chu kỳ (giây; JSON ≥ 5, server ≥ 15)', type: 'number', min: 5, max: 86400 },
  item: { label: 'Mục RSS / Atom (đếm từ 0)', type: 'number', min: 0, max: 999 },
  secretRef: { label: 'Tên khóa đã lưu trên server (nguồn qua server)', type: 'text' }
};
export const POSTER_FIELDS = {
  title: { label: 'Tiêu đề', type: 'multiline', source: '/title' },
  description: { label: 'Mô tả', type: 'multiline', source: '/description' },
  kicker: { label: 'Dòng dẫn', type: 'text', source: '/kicker' },
  footer: { label: 'Chân trang', type: 'text', source: '/footer' },
  image: { label: 'URL ảnh', type: 'imageUrl', source: '/image' }
};
export const SAMPLE_CONFIG = {
  version: 1, adapterId: 'manual', templateId: 'poster', contentRevision: 0,
  config: { fields: { title: 'Đổi góc nhìn.\nGiữ nguyên\nhình dáng.', description: 'Một màn hình phẳng. Một góc nhìn mới.\nĐể phối cảnh làm phần còn lại.', kicker: 'MỘT ĐIỂM NHÌN. MỘT PHỐI CẢNH.', footer: 'GÓC NHÌN THAY ĐỔI — HÌNH DÁNG VẸN NGUYÊN', image: '' } },
  fieldMap: POSTER_FIELDS
};
const own = (object, key) => Object.hasOwn(object, key);
export function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
export function sourceURL(value, protocols = ['http:', 'https:']) {
  if (typeof value !== 'string' || value.length > 2048) fail('URL không hợp lệ.');
  let url; try { url = new URL(value); } catch { fail('Cần URL tuyệt đối hợp lệ.'); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) fail('URL không được chứa tài khoản, mật khẩu hoặc phần #.');
  return url.href;
}
export function validateFieldMap(value) {
  if (!record(value) || Object.keys(value).length > 24 || !Object.keys(value).length) fail('Cần từ 1 đến 24 trường ánh xạ.');
  const result = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[a-zA-Z][\w-]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name) || !record(spec)) fail('Tên trường không hợp lệ.');
    const type = spec.type || 'text';
    if (!own(FIELD_TYPES, type)) fail('Loại trường không được hỗ trợ.');
    if (typeof spec.source !== 'string' || spec.source.length > 300) fail('Đường dẫn ánh xạ tối đa 300 ký tự.');
    const formatters = spec.formatters || [];
    if (!Array.isArray(formatters) || formatters.length > 4 || formatters.some(f => !FORMATTERS.includes(f))) fail('Bộ định dạng không được hỗ trợ.');
    const maxLength = spec.maxLength ?? FIELD_TYPES[type];
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > FIELD_TYPES[type]) fail('Giới hạn độ dài trường không hợp lệ.');
    if (spec.attribute && !['src', 'href', 'content', 'datetime', 'title'].includes(spec.attribute)) fail('Thuộc tính trích xuất không được hỗ trợ.');
    result[name] = { source: spec.source, type, label: String(spec.label || name).slice(0, 80), maxLength, formatters: [...formatters], ...(spec.attribute ? { attribute: spec.attribute } : {}) };
  }
  return result;
}
export function normalizeFields(fields, fieldMap, baseURL) {
  const result = {};
  for (const [name, spec] of Object.entries(fieldMap)) {
    const raw = fields && own(fields, name) ? fields[name] : '';
    let value = ['string', 'number', 'boolean'].includes(typeof raw) ? String(raw) : '';
    value = value.slice(0, spec.maxLength || FIELD_TYPES[spec.type || 'text']);
    if (spec.type === 'imageUrl' && value) {
      try { value = sourceURL(new URL(value, baseURL).href); } catch { value = ''; }
    }
    result[name] = value;
  }
  return result;
}
export function isServerSource(value) { return ['rss', 'html'].includes(value.adapterId) || value.adapterId === 'json' && value.config.proxy; }
export function validateContent(value) {
  if (!record(value) || value.version !== 1 || !own(ADAPTERS, value.adapterId) || !own(TEMPLATES, value.templateId)) fail('Cấu hình nội dung không được hỗ trợ.');
  if (new TextEncoder().encode(JSON.stringify(value)).length > 60000) fail('Cấu hình vượt 60.000 byte UTF-8.');
  const fieldMap = validateFieldMap(value.fieldMap), input = value.config;
  if (!record(input)) fail('Thiếu cấu hình nguồn.');
  const allowed = value.adapterId === 'manual' ? ['fields'] : ADAPTERS[value.adapterId].inputs;
  if (Object.keys(input).some(k => !allowed.includes(k))) fail('Cấu hình có thuộc tính không hỗ trợ; không nhập khóa API vào cấu hình.');
  const config = {};
  if (value.adapterId === 'manual') {
    if (!record(input.fields)) fail('Cần các trường nhập tay.');
    config.fields = normalizeFields(input.fields, fieldMap);
  } else {
    if (allowed.includes('url')) config.url = sourceURL(input.url, value.adapterId === 'websocket' ? ['ws:', 'wss:'] : undefined);
    if (allowed.includes('proxy')) config.proxy = input.proxy === true;
    if (allowed.includes('interval')) {
      config.interval = Number(input.interval ?? 30);
      const min = value.adapterId === 'json' && !config.proxy ? 5 : 15;
      if (!Number.isFinite(config.interval) || config.interval < min || config.interval > 86400) fail(`Chu kỳ nguồn này phải từ ${min} đến 86400 giây.`);
    }
    if (allowed.includes('item')) {
      config.item = Number(input.item ?? 0);
      if (!Number.isInteger(config.item) || config.item < 0 || config.item > 999) fail('Chỉ số mục từ 0 đến 999.');
    }
    if (input.secretRef) {
      if (!(config.proxy || ['rss', 'html'].includes(value.adapterId)) || !/^[a-zA-Z][\w-]{0,39}$/.test(input.secretRef)) fail('Khóa có tên chỉ dùng cho nguồn qua server.');
      config.secretRef = input.secretRef;
    }
  }
  return { version: 1, adapterId: value.adapterId, config, templateId: value.templateId, fieldMap,
    contentRevision: Number.isSafeInteger(value.contentRevision) && value.contentRevision >= 0 ? value.contentRevision : 0 };
}
