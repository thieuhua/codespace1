import { ADAPTERS, FIELD_TYPES, INPUTS, POSTER_FIELDS, SAMPLE_CONFIG, TEMPLATES, validateContent } from '/shared/content/schema.js';

function element(tag, text, className) {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
}
function label(text, input) { const node = element('label'); node.append(element('span', text), input); return node; }
function select(values, name) {
  const node = element('select'); node.name = name;
  for (const [value, title] of Object.entries(values)) { const option = element('option', title); option.value = value; node.append(option); }
  return node;
}
export class ContentPanel {
  constructor(container, { apply, preview, saveSecret, editable = () => true, display = false }) {
    this.container = container; this.apply = apply; this.preview = preview; this.saveSecret = saveSecret; this.editable = editable; this.display = display;
    this.adapter = select(Object.fromEntries(Object.entries(ADAPTERS).map(([id, spec]) => [id, spec.label])), 'adapterId');
    this.inputs = element('div', '', 'content-inputs');
    this.message = element('p', '', 'content-message'); this.message.setAttribute('role', 'status');
    const test = element('button', 'Thử'), applyButton = element('button', 'Áp dụng', 'primary'), sample = element('button', 'Dùng nội dung mẫu');
    const mapping = element('details'); mapping.append(element('summary', 'Ánh xạ trường'));
    this.mapping = element('textarea'); this.mapping.name = 'fieldMap'; this.mapping.rows = 8; this.mapping.spellcheck = false;
    mapping.append(label('JSON: source, type (text / multiline / imageUrl), label, formatters', this.mapping), element('p', 'JSON dùng /đường/dẫn; RSS dùng tên thẻ; HTML dùng selector đơn giản. Định dạng: trim, upper, date, number.'));
    this.mapping.onchange = () => { if (this.adapter.value === 'manual') { try { const draft = this.read(); this.buildInputs(draft); } catch (error) { this.notice(error.message); } } };
    this.template = select(TEMPLATES, 'templateId');
    const actions = element('div', '', 'content-actions'); actions.append(applyButton, sample);
    container.append(label('Nguồn nội dung', this.adapter), this.inputs, test, this.message, mapping, label('Mẫu hiển thị', this.template), actions);
    this.adapter.onchange = () => {
      const adapterId = this.adapter.value;
      const fieldMap = structuredClone(POSTER_FIELDS);
      if (adapterId === 'rss') for (const [key, spec] of Object.entries(fieldMap)) spec.source = { title: 'title', description: 'description', image: 'enclosure', footer: 'link', kicker: 'pubdate' }[key];
      if (adapterId === 'html') for (const [key, spec] of Object.entries(fieldMap)) { spec.source = { title: 'h1', description: 'p', image: 'img', footer: 'title', kicker: 'h2' }[key]; if (key === 'image') spec.attribute = 'src'; }
      this.load({ ...SAMPLE_CONFIG, contentRevision: this.revision, adapterId, fieldMap, config: adapterId === 'manual' ? structuredClone(SAMPLE_CONFIG.config) : { url: '', interval: 30, item: 0 } });
    };
    test.onclick = () => this.perform(async () => {
      const fields = await this.preview(this.read()); this.message.textContent = JSON.stringify(fields, null, 2);
    });
    applyButton.onclick = () => this.perform(async () => { await this.apply(this.read()); this.notice('Đã áp dụng nội dung.'); });
    sample.onclick = () => this.load({ ...structuredClone(SAMPLE_CONFIG), contentRevision: this.revision });
    this.load(SAMPLE_CONFIG);
  }
  notice(text) { this.message.textContent = text; }
  async perform(action) {
    if (!this.editable()) { this.notice('Cần mở đường dẫn từ QR có khóa điều khiển. Nếu khóa đã mất, tạo phiên mới trên máy tính.'); return; }
    try { this.notice('Đang xử lý…'); await action(); } catch (error) { this.notice(error.message); }
  }
  load(value) {
    this.revision = value.contentRevision || 0; this.adapter.value = value.adapterId; this.template.value = value.templateId;
    this.mapping.value = JSON.stringify(value.fieldMap, null, 2); this.buildInputs(value);
  }
  buildInputs(value) {
    this.inputs.replaceChildren();
    if (value.adapterId === 'manual') {
      for (const [name, spec] of Object.entries(value.fieldMap)) {
        const input = element('textarea'); input.name = `field:${name}`; input.rows = spec.type === 'multiline' ? 3 : 2;
        input.maxLength = spec.maxLength || FIELD_TYPES[spec.type || 'text']; input.value = value.config.fields?.[name] || '';
        if (name === 'title' && this.display) input.id = 'text-input';
        this.inputs.append(label(spec.label || name, input));
      }
    } else {
      for (const name of ADAPTERS[value.adapterId].inputs) {
        const spec = INPUTS[name], input = element('input'); input.name = name; input.type = spec.type;
        if (spec.min !== undefined) { input.min = spec.min; input.max = spec.max; }
        if (spec.type === 'checkbox') input.checked = !!value.config[name]; else input.value = value.config[name] ?? (name === 'interval' ? 30 : name === 'item' ? 0 : '');
        this.inputs.append(label(spec.label, input));
      }
    }
    if (value.adapterId === 'iframe') this.inputs.append(element('p', 'Trang nhúng bị sandbox và không render canvas 2×. Nhiều website chặn nhúng; ô trắng không có nghĩa là đã tải thành công.'));
    if (value.adapterId === 'html') this.inputs.append(element('p', 'Chỉ đọc HTML tĩnh; không chạy JavaScript của website nguồn.'));
    if (['json', 'rss', 'html'].includes(value.adapterId) && this.display) {
      const details = element('details'); details.append(element('summary', 'Nhập khóa nguồn vào RAM server'));
      const name = element('input'), header = element('input'), secret = element('input'); name.placeholder = 'ten-khoa'; header.value = 'Authorization'; secret.type = 'password'; secret.autocomplete = 'off';
      details.append(label('Tên tham chiếu', name), label('Header: Authorization / X-Api-Key', header), label('Giá trị (ví dụ Bearer …)', secret));
      const save = element('button', 'Lưu khóa trên server');
      save.onclick = () => this.perform(async () => {
        try { await this.saveSecret({ name: name.value, header: header.value, value: secret.value, url: this.inputs.querySelector('[name=url]').value }); this.notice('Đã lưu khóa cho origin này. Điền tên khóa vào nguồn qua server.'); }
        finally { secret.value = ''; }
      });
      details.append(save); this.inputs.append(details);
    }
  }
  read() {
    const config = {}, adapterId = this.adapter.value;
    if (adapterId === 'manual') {
      config.fields = {};
      for (const input of this.inputs.querySelectorAll('textarea')) config.fields[input.name.slice(6)] = input.value;
    } else for (const name of ADAPTERS[adapterId].inputs) { const input = this.inputs.querySelector(`[name=${name}]`); config[name] = input.type === 'checkbox' ? input.checked : input.value; }
    return validateContent({ version: 1, adapterId, config, templateId: this.template.value, fieldMap: JSON.parse(this.mapping.value), contentRevision: this.revision });
  }
}
