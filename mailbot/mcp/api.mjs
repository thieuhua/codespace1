export function apiClient({ url, token, jobToken = false }, fetchImpl = fetch) {
  if (!url || !token) throw new Error('Thiếu URL/token mailbot');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('URL không hợp lệ');
  return async (path, body, timeout = 10000) => {
    const res = await fetchImpl(base.href.replace(/\/+$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(jobToken ? { 'X-Job-Token': token } : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Mailbot ${res.status}: ${data.error || res.statusText}`);
    return data;
  };
}

export const toolResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
export const toolCall = (fn) => async (args) => {
  try { return toolResult(await fn(args)); }
  catch (e) { return { ...toolResult({ error: e.message }), isError: true }; }
};
