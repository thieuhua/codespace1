export function ticker(document, fields) {
  const text = document.createElement('div'); text.id = 'ticker-text';
  text.textContent = fields.title || Object.values(fields).find(Boolean) || '';
  return [text];
}
