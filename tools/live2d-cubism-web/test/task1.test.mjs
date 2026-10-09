import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import loader from '../../../renderer/live2d-product-loader.js';
import { createOwnerLifecycle } from '../src/runtime-owner.mjs';
import { createAlphaSampler } from '../src/runtime-alpha.mjs';
import { provisionProductWeb } from '../provision-product-web.mjs';

const { chooseStack, validateSemanticCommand } = loader;

test('loader keeps fixed provisioned URLs and strict semantic schema', () => {
  const selected = chooseStack({ cubismWeb: { provisioned: true,
    coreURL: 'pet-user://live2d-runtime/live2dcubismcore.js',
    runtimeURL: 'pet-user://live2d-runtime/live2d-runtime.js',
    shaderURL: 'pet-user://live2d-runtime/Framework/Shaders/WebGL/',
    modelURL: 'pet-user://live2d/Haru/Haru.model3.json' } });
  assert.equal(selected.kind, 'cubism-web');
  assert.equal(validateSemanticCommand({ type: 'mouth', value: 0.4 }), true);
  assert.equal(validateSemanticCommand({ type: 'mouth', value: '0.4' }), false);
  assert.equal(validateSemanticCommand({ type: 'motion', name: 'TapBody' }), false);
  assert.equal(validateSemanticCommand({ type: 'mouth', value: 0.4, nested: {} }), false);
  assert.equal(chooseStack({ cubismWeb: { provisioned: true, coreURL: 'https://invalid/core.js' } }).kind, 'legacy');
});

test('runtime owner lifecycle uses opaque object identity and stale rejection', () => {
  const lifecycle = createOwnerLifecycle();
  const oldToken = {};
  const newToken = {};
  const oldOwner = lifecycle.begin(oldToken);
  const newOwner = lifecycle.begin(newToken);
  assert.equal(lifecycle.isCurrent(oldOwner), false);
  assert.equal(lifecycle.accepts(oldOwner, oldToken), false);
  assert.equal(lifecycle.accepts(newOwner, oldToken), false);
  assert.equal(lifecycle.accepts(newOwner, newToken), true);
  lifecycle.retire(newOwner);
  assert.equal(lifecycle.accepts(newOwner, newToken), false);
});

test('actual runtime init and teardown retain the registered owner object', async () => {
  // Exercise the real entry's state logic with deterministic draw dependencies.
  // This unit check does not claim to verify Cubism rendering or native input.
  const entryURL = new URL('../src/runtime.ts', import.meta.url);
  const source = stripTypeScriptTypes((await fs.readFile(entryURL, 'utf8'))
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default Live2DRuntime;', 'globalThis.testRuntime = Live2DRuntime;'));
  const canvas = { width: 300, height: 460, clientWidth: 300, clientHeight: 460,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 460, width: 300, height: 460 }) };
  let releases = 0;
  const host = new EventTarget();
  Object.assign(host, { setTimeout, clearTimeout });
  const model = { isRendererReady: () => true, getLeaseEvidence: () => ({ disposed: false }) };
  const gl = { drawingBufferWidth: 300, drawingBufferHeight: 460 };
  const manager = { getModel: () => model, stop() {}, getObservedParameters: () => ({ mouthOpenY: 0 }) };
  const sub = { getCanvas: () => canvas, getGl: () => gl, getLive2DManager: () => manager };
  const dependencies = {
    window: host, console, Date, Math, Uint8Array, globalThis: null,
    createOwnerLifecycle, createAlphaSampler, Live2dProductLoader: loader,
    CubismShaderManager_WebGL: { getInstance: () => ({ getShader: () => ({ _isShaderLoaded: true }) }) },
    LAppPal: { getDeltaTime: () => 1 / 60 },
    LAppDelegate: { getInstance: () => ({ initialize: () => true, getSubdelegate: () => sub,
      run: () => queueMicrotask(() => host.dispatchEvent(new Event('cubism-frame-rendered'))),
      dispose: () => { releases += 1; } }) }
  };
  dependencies.globalThis = dependencies;
  vm.runInNewContext(source, dependencies);
  const runtime = dependencies.testRuntime;
  const oldToken = {}, newToken = {};
  assert.equal(await runtime.init(canvas, 'pet-user://live2d/Haru/Haru.model3.json', oldToken, { readyTimeoutMs: 40 }), true);
  assert.equal(runtime.snapshot().frameReady, true);
  assert.equal(await runtime.init(canvas, 'pet-user://live2d/Haru/Haru.model3.json', newToken, { readyTimeoutMs: 40 }), true);
  assert.equal(releases, 1);
  assert.equal(runtime.destroy(oldToken), false);
  assert.equal(runtime.snapshot().active, true);
  assert.equal(runtime.destroy(), true);
  assert.equal(runtime.snapshot().active, false);
  assert.equal(releases, 2);
});

test('post-frame alpha cache remains stable for repeated static-point consumers', () => {
  const sampler = createAlphaSampler();
  const owner = {};
  const rect = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 };
  assert.equal(sampler.submit(owner, 40, 50, rect), false);
  let reads = 0;
  sampler.sample(owner, 1, rect, () => { reads += 1; return true; });
  assert.equal(sampler.submit(owner, 40, 50, rect), true);
  assert.equal(sampler.submit(owner, 40, 50, rect), true);
  assert.equal(reads, 1);
  sampler.sample(owner, 2, rect, () => { reads += 1; return true; });
  assert.equal(sampler.submit(owner, 40, 50, rect), true);
  assert.equal(reads, 2);
  assert.equal(sampler.submit(owner, 41, 50, rect), false);
});

test('built IIFE exposes bounded runtime API and no-owner destroy is safe', async () => {
  const bundle = await fs.readFile(path.resolve(process.env.TASK1_BUNDLE || 'E:/WhiteMoon/work/live2d-sussurro-2026/phase1-runtime-decision/product-build-task1-r4/dist/live2d-runtime/live2d-runtime.js'), 'utf8');
  const sandbox = { console, performance: { now: () => 0 }, setTimeout, clearTimeout, Uint8Array, Date, Math };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const coreCallable = new Proxy(function () { return 0; }, { get: () => coreCallable, apply: () => 0 });
  sandbox.Live2DCubismCore = new Proxy({}, { get: () => coreCallable });
  sandbox.document = { addEventListener() {}, removeEventListener() {} };
  sandbox.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  vm.runInNewContext(bundle, sandbox);
  const runtime = sandbox.Live2DRuntime;
  assert.equal(typeof runtime.init, 'function');
  assert.equal(typeof runtime.interactiveAt, 'function');
  assert.equal(runtime.destroy(), false);
  assert.equal(runtime.destroy({}), false);
  assert.equal(runtime.command({ type: 'mouth', value: 0.4 }), false);
  assert.equal(runtime.snapshot().active, false);
});

test('provisioner is explicit and non-overwriting', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whitemoon-task1-'));
  const sdk = path.join(root, 'sdk');
  const runtime = path.join(root, 'runtime');
  const model = path.join(root, 'model');
  const profile = path.join(root, 'profile');
  await fs.mkdir(path.join(sdk, 'Core'), { recursive: true });
  await fs.mkdir(path.join(sdk, 'Framework', 'Shaders', 'WebGL'), { recursive: true });
  await fs.mkdir(runtime); await fs.mkdir(model);
  await fs.writeFile(path.join(sdk, 'Core', 'live2dcubismcore.js'), 'core');
  await fs.writeFile(path.join(sdk, 'Framework', 'Shaders', 'WebGL', 'vert.frag'), 'shader');
  await fs.writeFile(path.join(runtime, 'live2d-runtime.js'), 'runtime');
  await fs.writeFile(path.join(model, 'Haru.model3.json'), '{}');
  assert.equal((await provisionProductWeb({ sdkRoot: sdk, runtimeDir: runtime, modelDir: model, profileDir: profile })).provisioned, true);
  await assert.rejects(() => provisionProductWeb({ sdkRoot: sdk, runtimeDir: runtime, modelDir: model, profileDir: profile }), /refusing to overwrite/i);
});
