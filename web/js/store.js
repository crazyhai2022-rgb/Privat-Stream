// Small client-side stores that survive client-side navigation (and, for text, a refresh).
//
//  - research: the last SEO analysis. Only the generated suggestions and the URL are kept (never the
//    fetched page's text), in localStorage, so results are still there after a refresh or tomorrow.
//  - draft: the upload form's text fields, in sessionStorage (gone when the tab closes). The chosen
//    video File and thumbnail Blob cannot be serialised, so they live in memory for the SPA session.
const RKEY = 'vx.research.v1', DKEY = 'vx.upload-draft.v1';

const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const write = (store, key, v) => { try { v === null ? store.removeItem(key) : store.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable: memory only */ } };
const ls = () => { try { return window.localStorage; } catch { return null; } };
const ss = () => { try { return window.sessionStorage; } catch { return null; } };

// ---- Research -------------------------------------------------------------------------------
const emptyResearch = () => ({ url: '', count: 3, result: null, analyzedAt: null });
let research = null;
export function getResearch() {
  if (!research) { const saved = ls() && read(ls(), RKEY); research = { ...emptyResearch(), ...(saved || {}) }; }
  return research;
}
export function setResearch(patch) {
  research = { ...getResearch(), ...patch };
  if (ls()) write(ls(), RKEY, research);
  return research;
}
export function clearResearch() { research = emptyResearch(); if (ls()) write(ls(), RKEY, null); return research; }

// ---- Upload draft ---------------------------------------------------------------------------
const emptyDraft = () => ({ title: '', description: '', tags: '', categoryId: '', fromResearch: false });
let draft = null;
const mem = { file: null, fileKind: null, thumb: null }; // not serialisable, memory only
export function getDraft() {
  if (!draft) { const saved = ss() && read(ss(), DKEY); draft = { ...emptyDraft(), ...(saved || {}) }; }
  return draft;
}
export function patchDraft(patch) {
  draft = { ...getDraft(), ...patch };
  if (ss()) write(ss(), DKEY, draft);
  return draft;
}
export function clearDraft() { draft = emptyDraft(); mem.file = null; mem.fileKind = null; mem.thumb = null; if (ss()) write(ss(), DKEY, null); }
export const draftFiles = mem;
