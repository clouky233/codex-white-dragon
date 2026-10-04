/* Native window input region. Transparent sprite pixels must let the desktop through. */
(function (root) {
  'use strict';

  const ALPHA_THRESHOLD = 12;
  const FRAMES = { idle: 0, thinking: 1, complete: 2, waiting: 3, low: 4, pinch: 5, error: 4 };

  function maskRectangles(rgba, width, height, { flip = false, padding = 1 } = {}) {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sampleX = flip ? width - 1 - x : x;
        if (rgba[(y * width + sampleX) * 4 + 3] < ALPHA_THRESHOLD) continue;
        // One CSS pixel protects antialiased edges without capturing the empty frame.
        for (let dy = -padding; dy <= padding; dy++) {
          const row = y + dy;
          if (row < 0 || row >= height) continue;
          for (let dx = -padding; dx <= padding; dx++) {
            const column = x + dx;
            if (column >= 0 && column < width) mask[row * width + column] = 1;
          }
        }
      }
    }
    const rectangles = [];
    let preceding = new Map();
    for (let y = 0; y < height; y++) {
      const current = new Map();
      for (let x = 0; x < width;) {
        if (!mask[y * width + x]) { x++; continue; }
        const start = x;
        while (x < width && mask[y * width + x]) x++;
        const key = `${start}:${x - start}`;
        let rectangle = preceding.get(key);
        if (rectangle) rectangle.height++;
        else {
          rectangle = { x: start, y, width: x - start, height: 1 };
          rectangles.push(rectangle);
        }
        current.set(key, rectangle);
      }
      preceding = current;
    }
    return rectangles;
  }

  function roundedRectangles(bounds, requestedRadius = 0) {
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
    const width = Math.ceil(bounds.x + bounds.width) - x;
    const height = Math.ceil(bounds.y + bounds.height) - y;
    if (width <= 0 || height <= 0) return [];
    const radius = Math.max(0, Math.min(requestedRadius, width / 2, height / 2));
    const rectangles = [];
    for (let row = 0; row < height; row++) {
      const distance = Math.max(0, radius - Math.min(row + .5, height - row - .5));
      const inset = Math.max(0, Math.floor(radius - Math.sqrt(radius * radius - distance * distance)));
      const previous = rectangles[rectangles.length - 1];
      if (previous && previous.x === x + inset && previous.width === width - inset * 2) previous.height++;
      else rectangles.push({ x: x + inset, y: y + row, width: width - inset * 2, height: 1 });
    }
    return rectangles;
  }

  function clipRectangles(rectangles, width, height) {
    return rectangles.flatMap(rectangle => {
      const x = Math.max(0, Math.floor(rectangle.x));
      const y = Math.max(0, Math.floor(rectangle.y));
      const right = Math.min(width, Math.ceil(rectangle.x + rectangle.width));
      const bottom = Math.min(height, Math.ceil(rectangle.y + rectangle.height));
      return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { maskRectangles, roundedRectangles, clipRectangles, FRAMES };
  }
  if (!root.document) return;

  const document = root.document;
  const dragon = document.getElementById('dragon');
  if (!dragon) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const sheet = new Image();
  const masks = new Map();
  let ready = false, imageError = null, scheduled = false, lastSignature = '';
  let snapshot = { ready: false, rects: [], width: root.innerWidth, height: root.innerHeight, frame: 0 };

  function visible(element) {
    if (!element || element.getClientRects().length === 0) return false;
    // Descendants keep their own computed display/opacity even when a parent
    // hides the whole bubble. Never retain an invisible child's input region.
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden) return false;
      const style = root.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function panelRectangles(selector) {
    const element = document.querySelector(selector);
    if (!visible(element)) return [];
    const bounds = element.getBoundingClientRect();
    const radius = parseFloat(root.getComputedStyle(element).borderTopLeftRadius) || 0;
    return roundedRectangles(bounds, radius);
  }

  function spriteRectangles(frame, flipped) {
    if (!ready || !visible(dragon)) return [];
    const bounds = dragon.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(bounds.width)), height = Math.max(1, Math.ceil(bounds.height));
    const key = `${frame}:${width}:${height}:${flipped}`;
    let rectangles = masks.get(key);
    if (!rectangles) {
      canvas.width = width;
      canvas.height = height;
      const frameWidth = sheet.naturalWidth / 3, frameHeight = sheet.naturalHeight / 2;
      context.drawImage(sheet, (frame % 3) * frameWidth, Math.floor(frame / 3) * frameHeight,
        frameWidth, frameHeight, 0, 0, width, height);
      rectangles = maskRectangles(context.getImageData(0, 0, width, height).data, width, height, { flip: flipped });
      if (masks.size >= 32) masks.delete(masks.keys().next().value);
      masks.set(key, rectangles);
    }
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
    return rectangles.map(rectangle => ({ ...rectangle, x: rectangle.x + x, y: rectangle.y + y }));
  }

  function refresh() {
    scheduled = false;
    const frame = Object.entries(FRAMES).find(([name]) => dragon.classList.contains(name))?.[1] ?? 0;
    const flipped = !!dragon.closest('.dragon-wrap.flipped');
    const width = root.innerWidth, height = root.innerHeight;
    const rects = clipRectangles([
      ...panelRectangles('.quota-card'),
      ...panelRectangles('#notice'),
      ...spriteRectangles(frame, flipped)
    ], width, height);
    snapshot = { ready, imageError, rects, width, height, frame, flipped };
    // Electron interprets [] as "restore the whole window", never as an empty region.
    if (!rects.length || rects.length > 5000) return;
    const signature = JSON.stringify({ rects, width, height });
    if (signature === lastSignature || typeof root.dragon?.setHitRegion !== 'function') return;
    lastSignature = signature;
    root.dragon.setHitRegion({ rects, width, height });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    root.requestAnimationFrame(refresh);
  }

  sheet.onload = () => { ready = true; schedule(); };
  sheet.onerror = () => { imageError = 'Unable to load sprite alpha mask'; schedule(); };
  const background = root.getComputedStyle(dragon).backgroundImage;
  const imageUrl = background.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
  if (imageUrl) sheet.src = imageUrl;
  else imageError = 'Sprite background image is unavailable';

  new ResizeObserver(schedule).observe(document.querySelector('.widget'));
  const observed = ['.quota-card', '#notice', '#dragon'];
  const sizes = new ResizeObserver(schedule);
  observed.forEach(selector => { const element = document.querySelector(selector); if (element) sizes.observe(element); });
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true, subtree: true, characterData: true
  });
  document.addEventListener('scroll', schedule, true);
  root.addEventListener('resize', schedule);
  // CSS breathing does not trigger ResizeObserver. Check it at 10 Hz; unchanged
  // layouts produce no IPC, and cached masks avoid repeated canvas reads.
  const interval = root.setInterval(() => { if (!document.hidden) refresh(); }, 100);
  root.addEventListener('unload', () => root.clearInterval(interval), { once: true });
  root.dragonHitRegion = { refresh, getSnapshot: () => JSON.parse(JSON.stringify(snapshot)) };
  refresh();
})(typeof window === 'undefined' ? globalThis : window);
