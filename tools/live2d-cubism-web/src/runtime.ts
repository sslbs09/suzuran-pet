import { CubismShaderManager_WebGL } from '@framework/rendering/cubismshader_webgl';
import { LAppDelegate } from './lappdelegate';
import { LAppPal } from './lapppal';
import { createOwnerLifecycle } from './runtime-owner.mjs';

type RuntimeCommand = { type: string; value?: number; x?: number; y?: number; name?: string };
type RuntimeOptions = { shaderURL?: string; readyTimeoutMs?: number };
type RuntimeOwner = {
  token: unknown; delegate: LAppDelegate; modelURL: string; shaderURL: string;
  frameReady: boolean; disposed: boolean; generation: number; frameCount: number; frameTime: number;
  onFrame: (event: Event) => void; onAssetError: (event: Event) => void;
  cancelReady?: () => void;
  pendingAlpha: { x: number; y: number; rect: Rect } | null;
  alphaCache: { x: number; y: number; rect: Rect; frame: number; alpha: boolean } | null;
};

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

let activeOwner: RuntimeOwner | null = null;
const ownerLifecycle = createOwnerLifecycle();
let scale = 1;
let lastMood = 'idle';
let lastCommand: RuntimeCommand | null = null;
let requestedMouthOpen = 0;

function fail(message: string): never { throw new Error(message); }
function isCurrent(owner: RuntimeOwner): boolean { return activeOwner === owner && ownerLifecycle.isCurrent(owner); }
function manager(owner: RuntimeOwner) { return isCurrent(owner) ? owner.delegate.getSubdelegate(0)?.getLive2DManager() ?? null : null; }

function canvasRect(canvas: HTMLCanvasElement): Rect | null {
  const raw = canvas.getBoundingClientRect?.();
  if (!raw) return null;
  const width = Number(raw.width || canvas.clientWidth || canvas.width);
  const height = Number(raw.height || canvas.clientHeight || canvas.height);
  if (!(width > 0 && height > 0)) return null;
  return { left: raw.left, top: raw.top, right: raw.left + width, bottom: raw.top + height, width, height };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.width === b.width && a.height === b.height;
}

function modelParts(modelURL: string): { dir: string; file: string } {
  const clean = String(modelURL || '').split(/[?#]/, 1)[0];
  const slash = clean.lastIndexOf('/');
  if (slash <= 0 || !clean.endsWith('.model3.json')) fail('invalid modelURL');
  return { dir: clean.slice(0, slash + 1), file: clean.slice(slash + 1) };
}

function rendererReady(owner: RuntimeOwner): boolean {
  try {
    if (!isCurrent(owner)) return false;
    const sub = owner.delegate.getSubdelegate(0);
    const model = sub?.getLive2DManager()?.getModel();
    const gl = sub?.getGl();
    const shader = gl ? CubismShaderManager_WebGL.getInstance().getShader(gl) : null;
    const canvas = sub?.getCanvas();
    const rect = canvas ? canvasRect(canvas) : null;
    const bufferWidth = Number(gl?.drawingBufferWidth || canvas?.width || 0);
    const bufferHeight = Number(gl?.drawingBufferHeight || canvas?.height || 0);
    return Boolean(model?.isRendererReady() && shader?._isShaderLoaded === true && canvas && rect && bufferWidth > 0 && bufferHeight > 0);
  } catch { return false; }
}

function samplePendingAlpha(owner: RuntimeOwner): void {
  const pending = owner.pendingAlpha;
  if (!pending || !isCurrent(owner) || !rendererReady(owner)) return;
  const sub = owner.delegate.getSubdelegate(0);
  const canvas = sub?.getCanvas();
  const gl = sub?.getGl();
  if (!canvas || !gl) return;
  const rect = canvasRect(canvas);
  if (!rect || !sameRect(rect, pending.rect)) { owner.alphaCache = null; return; }
  const px = Math.max(0, Math.min(canvas.width - 1, Math.floor((pending.x - rect.left) * canvas.width / rect.width)));
  const py = Math.max(0, Math.min(canvas.height - 1, Math.floor((rect.bottom - pending.y) * canvas.height / rect.height)));
  const pixel = new Uint8Array(4);
  try {
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    owner.alphaCache = { x: pending.x, y: pending.y, rect, frame: owner.frameCount, alpha: pixel[3] >= 16 };
  } catch { owner.alphaCache = null; }
}

function waitForReady(owner: RuntimeOwner, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: number;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('cubism-asset-error', owner.onAssetError);
      window.clearTimeout(timer);
      owner.cancelReady = undefined;
      resolve(ok && isCurrent(owner) && rendererReady(owner));
    };
    owner.onFrame = (event) => {
      if (!isCurrent(owner)) return finish(false);
      if (rendererReady(owner)) {
        owner.frameReady = true;
        owner.frameCount += 1;
        owner.frameTime = Number((event as CustomEvent).detail?.at || Date.now());
        samplePendingAlpha(owner);
        finish(true);
      }
    };
    owner.onAssetError = () => finish(false);
    owner.cancelReady = () => finish(false);
    window.addEventListener('cubism-frame-rendered', owner.onFrame);
    window.addEventListener('cubism-asset-error', owner.onAssetError);
    timer = window.setTimeout(() => finish(false), Math.max(1, timeoutMs));
  });
}

function releaseOwner(owner: RuntimeOwner): void {
  if (owner.disposed) return;
  ownerLifecycle.retire(owner);
  owner.cancelReady?.();
  window.removeEventListener('cubism-frame-rendered', owner.onFrame);
  window.removeEventListener('cubism-asset-error', owner.onAssetError);
  try { owner.delegate.getSubdelegate(0)?.getLive2DManager()?.stop(); } catch { /* bounded renderer stop */ }
  requestedMouthOpen = 0;
  try { owner.delegate.dispose(); } catch { /* bounded owner teardown */ }
  if (activeOwner === owner) activeOwner = null;
}

function validateSemanticCommand(command: RuntimeCommand): boolean {
  const validator = (globalThis as any).Live2dProductLoader?.validateSemanticCommand;
  return typeof validator === 'function' && validator(command) === true;
}

function alphaAt(owner: RuntimeOwner, clientX: number, clientY: number): boolean {
  if (!isCurrent(owner) || !owner.frameReady || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const sub = owner.delegate.getSubdelegate(0);
  const canvas = sub?.getCanvas();
  if (!canvas) return false;
  const rect = canvasRect(canvas);
  if (!rect || clientX < rect.left || clientY < rect.top || clientX >= rect.right || clientY >= rect.bottom) {
    owner.pendingAlpha = null; owner.alphaCache = null; return false;
  }
  if (!owner.pendingAlpha || owner.pendingAlpha.x !== clientX || owner.pendingAlpha.y !== clientY || !sameRect(owner.pendingAlpha.rect, rect)) {
    owner.pendingAlpha = { x: clientX, y: clientY, rect };
    owner.alphaCache = null;
    return false;
  }
  const cache = owner.alphaCache;
  if (!cache || cache.frame !== owner.frameCount || cache.x !== clientX || cache.y !== clientY || !sameRect(cache.rect, rect)) return false;
  owner.pendingAlpha = null;
  owner.alphaCache = null;
  return cache.alpha;
}

const Live2DRuntime = {
  async init(canvas: HTMLCanvasElement, modelURL: string, token: unknown, options: RuntimeOptions = {}): Promise<boolean> {
    if (!canvas || token === null || token === undefined) return false;
    const parts = modelParts(modelURL);
    const shaderURL = options.shaderURL || (globalThis as any).__LIVE2D_RUNTIME_CONFIG__?.shaderURL || 'pet-user://live2d-runtime/Framework/Shaders/WebGL/';
    if (activeOwner) releaseOwner(activeOwner);
    const identity = ownerLifecycle.begin(token);
    const owner: RuntimeOwner = {
      ...identity, token, delegate: LAppDelegate.getInstance(), modelURL, shaderURL,
      frameReady: false, generation: identity.generation, frameCount: 0, frameTime: 0,
      onFrame: () => {}, onAssetError: () => {}, pendingAlpha: null, alphaCache: null
    };
    activeOwner = owner;
    lastCommand = null;
    requestedMouthOpen = 0;
    try {
      if (!owner.delegate.initialize({ canvas, modelURL: parts.dir + parts.file, shaderURL })) {
        releaseOwner(owner);
        return false;
      }
      owner.delegate.run();
      const ready = await waitForReady(owner, options.readyTimeoutMs ?? 10000);
    if (!ready || !isCurrent(owner)) { releaseOwner(owner); return false; }
      return true;
    } catch {
      releaseOwner(owner);
      return false;
    }
  },
  destroy(token?: unknown): boolean {
    const owner = activeOwner;
    if (!owner) return false;
    if (!ownerLifecycle.accepts(owner, token)) return false;
    releaseOwner(owner);
    return true;
  },
  get active() { return activeOwner !== null && !activeOwner.disposed; },
  setMood(mood: string) {
    const owner = activeOwner;
    if (!owner || !isCurrent(owner)) return false;
    lastMood = String(mood || 'idle'); manager(owner)?.setMood(lastMood); return true;
  },
  poke() {
    const owner = activeOwner;
    if (!owner || !isCurrent(owner)) return false;
    manager(owner)?.poke(); return true;
  },
  setScale(value: number) { scale = Number.isFinite(value) && value > 0 ? value : 1; return scale; },
  command(command: RuntimeCommand) {
    const owner = activeOwner;
    if (!owner || !isCurrent(owner) || !validateSemanticCommand(command)) return false;
    lastCommand = { ...command };
    if (command.type === 'mouth') requestedMouthOpen = command.value as number;
    if (command.type === 'neutral' || command.type === 'stop') requestedMouthOpen = 0;
    manager(owner)?.command(command); return true;
  },
  hit(x: number, y: number) {
    const owner = activeOwner;
    return owner && isCurrent(owner) ? manager(owner)?.hitAtClient(Number(x), Number(y)) ?? null : null;
  },
  interactiveAt(x: number, y: number) { return activeOwner ? alphaAt(activeOwner, Number(x), Number(y)) : false; },
  snapshot() {
    const owner = activeOwner;
    const observedParams = owner ? manager(owner)?.getObservedParameters() ?? null : null;
    return {
      active: Boolean(owner && isCurrent(owner)), modelURL: owner?.modelURL || '', shaderURL: owner?.shaderURL || '', scale,
      mood: lastMood, requestedMouthOpen, requestedCommand: lastCommand, renderer: 'cubism-web-r5',
      frameReady: Boolean(owner?.frameReady), frameCount: owner?.frameCount || 0, frameTime: owner?.frameTime || LAppPal.getDeltaTime(),
      ownerGeneration: owner?.generation || 0, modelLease: owner ? manager(owner)?.getModel()?.getLeaseEvidence() ?? null : null,
      observedParams
    };
  }
};

export default Live2DRuntime;
