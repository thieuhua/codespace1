export function parseJSON(source) {
  try { return JSON.parse(source); } catch { throw new Error('Nguồn không phải JSON hợp lệ.'); }
}
