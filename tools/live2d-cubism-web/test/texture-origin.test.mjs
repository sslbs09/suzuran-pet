import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// Test the sample adapter's real load/disposal code, not Chromium's origin rules.
// The actual Electron/WebGL acceptance is recorded separately.
async function fixture({ paused = false, uploadFails = false } = {}) {
  const source = stripTypeScriptTypes((await fs.readFile(new URL('../src/lapptexturemanager.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/export class /g, 'class ')) + '\nglobalThis.TestTextureManager = LAppTextureManager;';
  const facts = { fetches: [], sources: [], revoked: [], uploads: [], deleted: [], errors: [], images: [] };
  let resume;
  const bodyReady = paused ? new Promise(resolve => { resume = resolve; }) : Promise.resolve();
  const host = new EventTarget();
  host.addEventListener('cubism-asset-error', event => facts.errors.push(event.detail));
  class Image {
    constructor() { this.width = 256; this.height = 256; this.listeners = new Map(); facts.images.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    set src(value) { facts.sources.push(value); queueMicrotask(() => this.listeners.get('load')?.()); }
  }
  const gl = { TEXTURE_2D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, LINEAR_MIPMAP_LINEAR: 4,
    LINEAR: 5, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 6, RGBA: 7, UNSIGNED_BYTE: 8,
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, pixelStorei() {}, generateMipmap() {},
    texImage2D(...args) { facts.uploads.push(args.at(-1)); if (uploadFails) throw new Error('upload failed'); },
    deleteTexture(texture) { facts.deleted.push(texture); } };
  const deps = { window: host, Image, AbortController, queueMicrotask, console,
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } },
    URL: { createObjectURL: () => 'blob:owned-texture', revokeObjectURL: value => facts.revoked.push(value) },
    fetch: async (url, options) => { facts.fetches.push({ url, signal: options?.signal }); return { ok: true, blob: async () => { await bodyReady; return {}; } }; } };
  vm.runInNewContext(source, deps);
  const manager = new deps.TestTextureManager();
  manager.setGlManager({ getGl: () => gl });
  return { manager, facts, resume, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('protocol textures use readable bytes and a document-owned image URL', async () => {
  const { manager, facts, settle } = await fixture();
  let callbacks = 0;
  manager.createTextureFromPngFile('pet-user://live2d/Haru/texture_00.png', true, () => { callbacks++; });
  await settle();
  assert.equal(facts.fetches.length, 1);
  assert.deepEqual(facts.sources, ['blob:owned-texture']);
  assert.equal(facts.uploads.length, 1);
  assert.equal(callbacks, 1);
  assert.deepEqual(facts.revoked, ['blob:owned-texture']);
  manager.release();
  assert.equal(facts.deleted.length, 1);
});

test('retired texture bytes cannot create an image or upload after release', async () => {
  const { manager, facts, resume, settle } = await fixture({ paused: true });
  let callbacks = 0;
  manager.createTextureFromPngFile('pet-user://live2d/Haru/texture_00.png', true, () => { callbacks++; });
  await settle();
  manager.release();
  resume();
  await settle();
  assert.equal(facts.fetches[0].signal.aborted, true);
  assert.equal(facts.sources.length, 0);
  assert.equal(facts.uploads.length, 0);
  assert.equal(callbacks, 0);
  assert.equal(facts.errors.length, 0);
});

test('failed texture uploads release their URL and report a current asset failure', async () => {
  const { manager, facts, settle } = await fixture({ uploadFails: true });
  let callbacks = 0;
  manager.createTextureFromPngFile('pet-user://live2d/Haru/texture_00.png', true, () => { callbacks++; });
  await settle();
  assert.equal(callbacks, 0);
  assert.deepEqual(facts.revoked, ['blob:owned-texture']);
  assert.equal(facts.deleted.length, 1);
  assert.equal(facts.errors.length, 1);
});
