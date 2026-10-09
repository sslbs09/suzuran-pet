import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import loader from '../../../renderer/live2d-product-loader.js';
import { createOwnerLifecycle } from '../src/runtime-owner.mjs';
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
