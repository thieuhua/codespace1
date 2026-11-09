import { normalizeFields } from '../../../shared/content/schema.js';
import { poster } from './templates/poster.js';
import { fields } from './templates/fields.js';
import { ticker } from './templates/ticker.js';

export function renderFields(container, values, config, { localImage } = {}) {
  const document = container.ownerDocument, normalized = normalizeFields(values, config.fieldMap);
  if (config.adapterId === 'manual' && localImage) {
    const name = Object.keys(config.fieldMap).find(key => config.fieldMap[key].type === 'imageUrl');
    if (name) normalized[name] = localImage;
  }
  const image = url => {
    const img = document.createElement('img'); img.referrerPolicy = 'no-referrer'; img.crossOrigin = 'anonymous';
    img.alt = 'Ảnh nội dung'; img.src = url; return img;
  };
  container.dataset.template = config.templateId;
  if (config.adapterId === 'iframe') {
    if (container.querySelector('iframe')?.src === config.config.url) return;
    const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
    frame.title = 'Trang nội dung nhúng'; frame.src = config.config.url; container.replaceChildren(frame);
  } else {
    const nodes = ({ poster, fields, ticker })[config.templateId](document, normalized, config.fieldMap, image);
    container.replaceChildren(...nodes);
    const imageURL = config.adapterId === 'manual' && localImage || (config.fieldMap.image?.type === 'imageUrl' ? normalized.image : '');
    if (config.templateId !== 'fields' && imageURL) { const img = image(imageURL); img.id = 'custom-image'; container.append(img); }
  }
  const grid = document.createElement('div'); grid.id = 'debug-grid'; grid.hidden = true; grid.setAttribute('aria-hidden', 'true'); container.append(grid);
}
export async function waitForAssets(container, timeoutMs = 5000) {
  let timeout;
  const assets = Promise.all([container.ownerDocument.fonts?.ready, ...[...container.querySelectorAll('img')].map(img => img.decode().catch(() => {}))]);
  try { await Promise.race([assets, new Promise(resolve => { timeout = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timeout); }
}
