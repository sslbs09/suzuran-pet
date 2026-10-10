import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlphaSampler } from '../src/runtime-alpha.mjs';

const rect = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 };
function frame(pixels) {
  // readPixels rows start at the bottom of the display framebuffer.
  pixels.fill(0);
  pixels[3] = 255;       // bottom left
  pixels[7] = 15;        // bottom right, below the hit threshold
  pixels[11] = 16;       // top left, at the hit threshold
  pixels[15] = 255;      // top right
}

test('one completed frame answers multiple first-time points without another GL read', () => {
  const sampler = createAlphaSampler(), owner = {};
  let reads = 0;
  assert.equal(sampler.at(owner, 35, 95, rect, 2, 2), false);
  assert.equal(sampler.sample(owner, 1, rect, 2, 2, pixels => { reads++; frame(pixels); }), true);
  assert.equal(sampler.at(owner, 35, 95, rect, 2, 2), true);
  assert.equal(sampler.at(owner, 85, 95, rect, 2, 2), false);
  assert.equal(sampler.at(owner, 35, 45, rect, 2, 2), true);
  assert.equal(sampler.at(owner, 85, 45, rect, 2, 2), true);
  assert.equal(sampler.at(owner, 36, 46, rect, 2, 2), true);
  assert.equal(reads, 1);
});

test('client edges, Y direction and non-finite coordinates never read outside the cache', () => {
  const sampler = createAlphaSampler(), owner = {};
  sampler.sample(owner, 1, rect, 2, 2, frame);
  assert.equal(sampler.at(owner, rect.left, rect.top, rect, 2, 2), true);
  assert.equal(sampler.at(owner, 109.99, 119.99, rect, 2, 2), false);
  for (const [x, y] of [[9, 50], [110, 50], [50, 19], [50, 120], [NaN, 40], [40, Infinity]]) {
    assert.equal(sampler.at(owner, x, y, rect, 2, 2), false);
  }
  // An outside query must not destroy the whole image for the next inside point.
  assert.equal(sampler.at(owner, 35, 45, rect, 2, 2), true);
});

test('fixed dimensions reuse one allocation, resize releases stale geometry', () => {
  const sampler = createAlphaSampler(), owner = {};
  const buffers = [];
  for (let i = 1; i <= 4; i++) sampler.sample(owner, i, rect, 2, 2, pixels => { buffers.push(pixels); frame(pixels); });
  assert.ok(buffers.every(x => x === buffers[0]));
  assert.equal(sampler.snapshot(owner).bufferAllocations, 1);
  assert.equal(sampler.snapshot(owner).bufferBytes, 16);
  assert.equal(sampler.at(owner, 35, 45, rect, 3, 2), false);
  assert.equal(sampler.at(owner, 35, 45, rect, 2, 2), false);
  sampler.sample(owner, 5, rect, 3, 2, pixels => { pixels.fill(255); buffers.push(pixels); });
  assert.notEqual(buffers[4], buffers[0]);
  assert.equal(sampler.snapshot(owner).bufferAllocations, 2);
  assert.equal(sampler.at(owner, 35, 45, rect, 3, 2), true);
});

test('owner changes, failed reads and rect changes cannot reuse old alpha', () => {
  const sampler = createAlphaSampler(), old = {}, current = {};
  sampler.sample(old, 1, rect, 2, 2, frame);
  assert.equal(sampler.at(current, 35, 45, rect, 2, 2), false);
  sampler.sample(current, 1, rect, 2, 2, frame);
  sampler.reset(old);
  assert.equal(sampler.at(current, 35, 45, rect, 2, 2), true);
  assert.equal(sampler.sample(current, 2, rect, 2, 2, () => { throw new Error('read failed'); }), false);
  assert.equal(sampler.at(current, 35, 45, rect, 2, 2), false);
  assert.equal(sampler.sample(current, 3, rect, 2, 2, () => false), false);
  assert.equal(sampler.at(current, 35, 45, rect, 2, 2), false);
  sampler.sample(current, 4, rect, 2, 2, frame);
  assert.equal(sampler.at(current, 35, 45, { ...rect, left: 11 }, 2, 2), false);
  assert.equal(sampler.at(current, 35, 45, rect, 2, 2), false);
  sampler.reset(current);
  assert.equal(sampler.snapshot(current).bufferBytes, 0);
  assert.equal(sampler.snapshot(current).ready, false);
});
