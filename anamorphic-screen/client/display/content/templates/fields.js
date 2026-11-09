export function fields(document, values, fieldMap, image) {
  const list = document.createElement('dl'); list.className = 'field-list';
  for (const [name, spec] of Object.entries(fieldMap)) {
    const label = document.createElement('dt'), value = document.createElement('dd'); label.textContent = spec.label;
    if (spec.type === 'imageUrl' && values[name]) value.append(image(values[name]));
    else value.textContent = values[name] || '';
    list.append(label, value);
  }
  return [list];
}
