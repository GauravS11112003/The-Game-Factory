/* Embedded by the server before game code. All image sources are packaged data URLs. */
(() => {
  const manifest = window.__drawPlayAssetManifest;
  delete window.__drawPlayAssetManifest;
  const images = Object.create(null);
  const failures = [];
  const used = new Set();
  const ready = Promise.all(Object.entries(manifest).map(([key, asset]) => new Promise(resolve => {
    const image = new Image();
    const timer = setTimeout(() => finish(false), 5000);
    let settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (ok) images[key] = image;
      else failures.push(key);
      resolve();
    }
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => finish(false);
    image.src = asset.src;
  })));
  function draw(ctx, key, x, y, width, height, options = {}) {
    const image = images[key], asset = manifest[key];
    if (!image || !asset || width <= 0 || height <= 0) return false;
    const frames = asset.frames || 1;
    const rawFrame = options.frame ?? Math.floor((options.time || 0) * (asset.fps || 8) / 1000);
    const frame = ((Math.floor(rawFrame) % frames) + frames) % frames;
    const sw = image.naturalWidth / frames;
    ctx.save();
    ctx.globalAlpha *= options.alpha ?? 1;
    ctx.translate(x + width / 2, y + height / 2);
    if (options.rotation) ctx.rotate(options.rotation);
    if (options.flip) ctx.scale(-1, 1);
    ctx.drawImage(image, frame * sw, 0, sw, image.naturalHeight, -width / 2, -height / 2, width, height);
    ctx.restore();
    used.add(key);
    return true;
  }
  window.drawPlayArt = Object.freeze({ manifest, images, ready, failures, draw, used });
})();
