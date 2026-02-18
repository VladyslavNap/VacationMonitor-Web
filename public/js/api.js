/* global VacationMonitor API client */
window.api = (() => {
  async function req(method, url, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error('Network error — please check your connection.');
    }
    if (res.status === 401) { window.location.href = '/'; return; }
    if (!res.ok) {
      let msg;
      try { const j = await res.json(); msg = j.message || j.error || `Error ${res.status}`; }
      catch { msg = `Request failed (${res.status})`; }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res;
  }
  return {
    get:   (url)       => req('GET',    url),
    post:  (url, body) => req('POST',   url, body),
    patch: (url, body) => req('PATCH',  url, body),
    del:   (url)       => req('DELETE', url),
  };
})();
