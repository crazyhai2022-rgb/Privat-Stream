// API client + shared app state.
export const state = { user: null, channel: null, canUpload: false, csrf: null, config: null };
const listeners = new Set();
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(state));

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

function headers(url, extra = {}) {
  const h = { Accept: 'application/json', 'X-Requested-With': 'fetch', ...extra };
  const tok = url.startsWith('/api/admin') ? state.adminCsrf : state.csrf;
  if (tok) h['X-CSRF-Token'] = tok;
  return h;
}

async function request(method, url, body) {
  const opts = { method, headers: headers(url, body !== undefined ? { 'Content-Type': 'application/json' } : {}), credentials: 'same-origin' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, { error: { message: 'Network error. Check your connection.' } }); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
};

// Multipart upload with progress (fetch cannot report upload progress).
export function upload(url, formData, { onProgress, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers(url))) xhr.setRequestHeader(k, v);
    xhr.responseType = 'json';
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(new ApiError(xhr.status, xhr.response)));
    xhr.onerror = () => reject(new ApiError(0, { error: { message: 'Upload failed. Check your connection.' } }));
    xhr.onabort = () => reject(new ApiError(0, { error: { message: 'Upload cancelled' } }));
    xhr.send(formData);
    upload.current = xhr;
  });
}

export function applyMe(data) {
  if (data && data.user) {
    state.user = data.user;
    state.channel = data.channel || null;
    state.canUpload = !!data.can_upload;
    if (data.csrf_token) state.csrf = data.csrf_token;
  } else {
    state.user = null; state.channel = null; state.canUpload = false; state.csrf = null;
  }
  emit();
}
export async function refreshMe() {
  try { applyMe(await api.get('/api/auth/me')); } catch { applyMe(null); }
  return state.user;
}
export async function loadConfig() {
  state.config = await api.get('/api/config');
  window.__brand = state.config.brand.name;
  return state.config;
}
export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
  applyMe(null);
}
