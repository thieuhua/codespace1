function node(document, tag, text, className, id) {
  const element = document.createElement(tag); element.textContent = text || '';
  if (className) element.className = className;
  if (id) element.id = id;
  return element;
}
export function poster(document, fields) {
  const top = node(document, 'div', '', 'poster-top');
  top.append(node(document, 'span', 'THỬ NGHIỆM THỊ GIÁC / 001'), node(document, 'span', 'ANAMORPHIC SCREEN ↗'));
  const layout = node(document, 'div', '', 'poster-layout'), copy = node(document, 'div', '', 'poster-copy');
  copy.append(node(document, 'div', fields.kicker, 'poster-kicker'), node(document, 'h1', fields.title, '', 'poster-text'), node(document, 'p', fields.description, '', 'poster-description'));
  const art = node(document, 'div', '', '', 'poster-art'); art.setAttribute('aria-hidden', 'true');
  for (const name of ['one', 'two', 'three']) art.append(node(document, 'div', '', `orbit orbit-${name}`));
  art.append(node(document, 'span', '↗'), node(document, 'small', '45°')); layout.append(copy, art);
  const bottom = node(document, 'div', '', 'poster-bottom'); bottom.append(node(document, 'span', fields.footer), node(document, 'span', '01 — ∞'));
  return [top, layout, bottom];
}
