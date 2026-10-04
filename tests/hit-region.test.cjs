const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const source = readFileSync(resolve(__dirname, '../src/ui/hit-region.js'), 'utf8');
const helpers = { exports: {} };
new Function('module', source)(helpers);
const { maskRectangles, roundedRectangles, clipRectangles, FRAMES } = helpers.exports;

const contains = (rectangles, x, y) => rectangles.some(rectangle =>
  x >= rectangle.x && x < rectangle.x + rectangle.width && y >= rectangle.y && y < rectangle.y + rectangle.height);

test('transparent sprite frame stays click-through, including internal holes', () => {
  const pixels = new Uint8ClampedArray(10 * 10 * 4);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) pixels[(y * 10 + x) * 4 + 3] = 255;
  pixels[(5 * 10 + 5) * 4 + 3] = 0;
  const rectangles = maskRectangles(pixels, 10, 10, { padding: 0 });
  assert.equal(contains(rectangles, 0, 0), false);
  assert.equal(contains(rectangles, 9, 9), false);
  assert.equal(contains(rectangles, 5, 5), false);
  assert.equal(contains(rectangles, 2, 2), true);
});

test('flipped sprites follow the visible pixels instead of the original side', () => {
  const pixels = new Uint8ClampedArray(8 * 4 * 4);
  pixels[(1 * 8 + 1) * 4 + 3] = 255;
  const normal = maskRectangles(pixels, 8, 4, { padding: 0 });
  const flipped = maskRectangles(pixels, 8, 4, { padding: 0, flip: true });
  assert.equal(contains(normal, 1, 1), true);
  assert.equal(contains(flipped, 1, 1), false);
  assert.equal(contains(flipped, 6, 1), true);
});

test('antialias tolerance is bounded to one pixel', () => {
  const pixels = new Uint8ClampedArray(9 * 9 * 4);
  pixels[(4 * 9 + 4) * 4 + 3] = 128;
  const rectangles = maskRectangles(pixels, 9, 9);
  assert.equal(contains(rectangles, 3, 3), true);
  assert.equal(contains(rectangles, 2, 4), false);
  assert.equal(rectangles.length, 1);
  assert.deepEqual(rectangles[0], { x: 3, y: 3, width: 3, height: 3 });
});

test('rounded panels leave corners and all lower whitespace click-through', () => {
  const rectangles = roundedRectangles({ x: 10, y: 20, width: 100, height: 80 }, 22);
  assert.equal(contains(rectangles, 10, 20), false);
  assert.equal(contains(rectangles, 60, 20), true);
  assert.equal(contains(rectangles, 10, 60), true);
  assert.equal(contains(rectangles, 60, 100), false);
  assert.equal(contains(rectangles, 109, 99), false);
});

test('offscreen and empty rectangles cannot enlarge the native window region', () => {
  assert.deepEqual(clipRectangles([
    { x: -10, y: -3, width: 30, height: 10 },
    { x: 95, y: 90, width: 50, height: 30 },
    { x: 110, y: 0, width: 20, height: 10 }
  ], 100, 100), [
    { x: 0, y: 0, width: 20, height: 7 },
    { x: 95, y: 90, width: 5, height: 10 }
  ]);
  assert.deepEqual(roundedRectangles({ x: 0, y: 0, width: 0, height: 0 }), []);
  assert.equal(FRAMES.error, FRAMES.low);
});

function rendererFixture() {
  const frameCallbacks = [], mutationCallbacks = [], sent = [];
  const element = (bounds, parentElement = null, extra = {}) => ({
    bounds, parentElement, hidden: false,
    style: { display: 'block', visibility: 'visible', opacity: '1', borderTopLeftRadius: '10px' },
    getBoundingClientRect() { return this.bounds; },
    getClientRects() {
      for (let parent = this; parent; parent = parent.parentElement) {
        if (parent.hidden || parent.style.display === 'none') return [];
      }
      return [this.bounds];
    },
    ...extra
  });
  const html = element({ x: 0, y: 0, width: 200, height: 220 });
  const widget = element(html.bounds, html);
  const bubbleContainer = element(html.bounds, widget);
  const card = element({ x: 20, y: 20, width: 120, height: 70 }, bubbleContainer, { hidden: true });
  const notice = element({ x: 20, y: 105, width: 120, height: 30 }, bubbleContainer, { hidden: true });
  const dragon = element({ x: 100, y: 160, width: 6, height: 6 }, widget, {
    classList: { contains: name => name === 'idle' }, closest: () => null
  });
  dragon.style.backgroundImage = 'url("file:///dragon-states.png")';
  const toolbar = element({ x: 70, y: 65, width: 60, height: 20 }, card);
  const selectors = {
    '.widget': widget, '.quota-card': card, '#notice': notice, '#dragon': dragon,
    '.toolbar > div': toolbar
  };
  const document = {
    documentElement: html,
    hidden: false,
    querySelector: selector => selectors[selector] || null,
    getElementById: id => id === 'dragon' ? dragon : null,
    addEventListener() {},
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData(_x, _y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 3; index < data.length; index += 4) data[index] = 255;
          return { data };
        }
      })
    })
  };
  const root = {
    document, innerWidth: 200, innerHeight: 220,
    getComputedStyle: element => element.style,
    requestAnimationFrame: callback => frameCallbacks.push(callback),
    addEventListener() {}, setInterval: () => 1, clearInterval() {},
    dragon: { setHitRegion: region => sent.push(region) }
  };
  class FakeImage {
    naturalWidth = 1536;
    naturalHeight = 1024;
    set src(_value) { this.onload(); }
  }
  class FakeResizeObserver { observe() {} }
  class FakeMutationObserver {
    constructor(callback) { mutationCallbacks.push(callback); }
    observe() {}
  }
  new Function('window', 'Image', 'ResizeObserver', 'MutationObserver', source)(
    root, FakeImage, FakeResizeObserver, FakeMutationObserver
  );
  const frame = () => { const pending = frameCallbacks.splice(0); pending.forEach(callback => callback()); };
  frame();
  return {
    root, card, notice, bubbleContainer, dragon, sent, frame,
    mutate: () => mutationCallbacks.forEach(callback => callback()),
    snapshot: () => root.dragonHitRegion.getSnapshot()
  };
}

test('hidden quota bubble and its toolbar have no native hit region', () => {
  const fixture = rendererFixture();
  assert.equal(contains(fixture.snapshot().rects, 80, 50), false);
  assert.equal(contains(fixture.snapshot().rects, 90, 75), false);
  assert.equal(contains(fixture.snapshot().rects, 80, 120), false);
  assert.equal(contains(fixture.snapshot().rects, 103, 163), true);
});

test('showing and hiding bubbles reports the new region in the same rendering frame', () => {
  const fixture = rendererFixture();
  const initialCount = fixture.sent.length;
  fixture.card.hidden = false;
  fixture.notice.hidden = false;
  fixture.mutate();
  fixture.frame();
  assert.equal(fixture.sent.length, initialCount + 1);
  assert.equal(contains(fixture.sent.at(-1).rects, 80, 50), true);
  assert.equal(contains(fixture.sent.at(-1).rects, 80, 120), true);
  fixture.card.hidden = true;
  fixture.notice.hidden = true;
  fixture.mutate();
  fixture.frame();
  assert.equal(fixture.sent.length, initialCount + 2);
  assert.equal(contains(fixture.sent.at(-1).rects, 80, 50), false);
  assert.equal(contains(fixture.sent.at(-1).rects, 90, 75), false);
  assert.equal(contains(fixture.sent.at(-1).rects, 80, 120), false);
  assert.equal(contains(fixture.sent.at(-1).rects, 103, 163), true);
});

test('all ancestor hiding mechanisms remove a visible child bubble from the region', () => {
  for (const [property, value] of [
    ['hidden', true], ['display', 'none'], ['visibility', 'hidden'], ['visibility', 'collapse'], ['opacity', '0']
  ]) {
    const fixture = rendererFixture();
    fixture.card.hidden = false;
    fixture.root.dragonHitRegion.refresh();
    assert.equal(contains(fixture.snapshot().rects, 80, 50), true);
    if (property === 'hidden') fixture.bubbleContainer.hidden = value;
    else fixture.bubbleContainer.style[property] = value;
    fixture.mutate();
    fixture.frame();
    assert.equal(contains(fixture.sent.at(-1).rects, 80, 50), false, property);
    assert.equal(contains(fixture.sent.at(-1).rects, 103, 163), true, property);
  }
});

test('an empty visible region never resets the native shape to the whole window', () => {
  const fixture = rendererFixture();
  const initialCount = fixture.sent.length;
  fixture.dragon.hidden = true;
  fixture.mutate();
  fixture.frame();
  assert.equal(fixture.snapshot().rects.length, 0);
  assert.equal(fixture.sent.length, initialCount);
  assert.equal(fixture.sent.every(region => region.rects.length > 0), true);
});
