/* 方格量度（純前端 CV，0 AI token）
   輸入：RGBA ImageData（俯拍、1cm 方格背景）
   輸出：{ box:{x,y,w,h}, wCm, dCm, periodX, periodY, localX, localY, confidence, note }
   只量足印 W × D；高度 H 由人手輸入（未包含）。
*/
(function () {
  const MAX_SIDE = 1200;

  function buildGray(data, W, H) {
    const N = W * H;
    const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N), gray = new Uint8Array(N);
    const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      R[i] = r; G[i] = g; B[i] = b; gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
      histR[r]++; histG[g]++; histB[b]++;
    }
    return { R, G, B, gray, histR, histG, histB };
  }

  function percentile(hist, n, q) {
    let c = 0; const target = q * n;
    for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= target) return v; }
    return 255;
  }

  function lineScore(axis, W, H, gray) {
    const n = axis === "x" ? W : H, m = axis === "x" ? H : W;
    const score = new Float32Array(n);
    const lo = Math.floor(m * 0.04), hi = Math.floor(m * 0.96);
    const win = 5;
    for (let a = 0; a < n; a++) {
      if (a < n * 0.03 || a > n * 0.97) continue;
      let dark = 0;
      for (let b = lo; b < hi; b++) {
        let hit = false;
        for (let k = -win; k <= win; k++) {
          const aa = a + k; if (aa < 0 || aa >= n) continue;
          const v = axis === "x" ? gray[b * W + aa] : gray[aa * W + b];
          if (v < 145) { hit = true; break; }
        }
        if (hit) dark++;
      }
      score[a] = dark / (hi - lo);
    }
    return score;
  }

  function smooth(a, r) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) { s += a[j]; c++; } }
      out[i] = s / c;
    }
    return out;
  }

  function autocorrPeriod(score, minLag, maxLag) {
    const s = smooth(score, 3);
    let mean = 0; for (const v of s) mean += v; mean /= s.length;
    const a = new Float32Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s[i] - mean;
    let bestLag = 0, best = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0; for (let i = 0; i + lag < a.length; i++) sum += a[i] * a[i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    return bestLag;
  }

  function peaks(score, minDist) {
    const s = smooth(score, 3), cand = [];
    for (let i = 2; i < s.length - 2; i++) {
      if (s[i] >= 0.45 && s[i] >= s[i - 1] && s[i] >= s[i + 1]) cand.push({ i, v: s[i] });
    }
    cand.sort((a, b) => b.v - a.v);
    const picked = [];
    for (const c of cand) if (picked.every((p) => Math.abs(p - c.i) >= minDist)) picked.push(c.i);
    picked.sort((a, b) => a - b);
    return picked;
  }

  function regularize(p, period) {
    if (!period || p.length < 3) return p;
    let best = [];
    for (let phase = 0; phase < period; phase += 2) {
      const keep = p.filter((q) => {
        const r = ((q - phase) % period + period) % period;
        return Math.min(r, period - r) < period * 0.18;
      });
      if (keep.length > best.length) best = keep;
    }
    return best.length >= 3 ? best : p;
  }

  function localPeriod(p, center) {
    if (p.length < 2) return 0;
    const ints = [];
    for (let i = 0; i + 1 < p.length; i++) ints.push({ d: p[i + 1] - p[i], mid: (p[i] + p[i + 1]) / 2 });
    ints.sort((a, b) => Math.abs(a.mid - center) - Math.abs(b.mid - center));
    const take = ints.slice(0, 2).filter((x) => x.d > 20);
    return take.length ? take.reduce((s, x) => s + x.d, 0) / take.length : 0;
  }

  function maxFilter(src, W, H, r) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W && src[y * W + xx]) { v = 1; break; } }
      tmp[y * W + x] = v;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) { v = 1; break; } }
      out[y * W + x] = v;
    }
    return out;
  }

  function minFilter(src, W, H, r) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 1;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= W || !src[y * W + xx]) { v = 0; break; } }
      tmp[y * W + x] = v;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 1;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= H || !tmp[yy * W + x]) { v = 0; break; } }
      out[y * W + x] = v;
    }
    return out;
  }

  function analyze(data, W, H) {
    const N = W * H;
    const { R, G, B, gray, histR, histG, histB } = buildGray(data, W, H);
    const pr = percentile(histR, N, 0.8), pg = percentile(histG, N, 0.8), pb = percentile(histB, N, 0.8);

    const scoreX = lineScore("x", W, H, gray), scoreY = lineScore("y", W, H, gray);
    let periodX = autocorrPeriod(scoreX, 45, 130);
    let periodY = autocorrPeriod(scoreY, 45, 130);
    if (periodX && periodY && Math.abs(periodX - periodY) / Math.max(periodX, periodY) > 0.22) {
      periodX = periodY = Math.max(periodX, periodY);
    }
    if (!periodX) periodX = periodY;
    if (!periodY) periodY = periodX;
    const gridOk = periodX >= 45 && periodX <= 130 && periodY >= 45 && periodY <= 130;

    const rawVx = peaks(scoreX, Math.max(20, Math.round(periodX * 0.35)));
    const rawVy = peaks(scoreY, Math.max(20, Math.round(periodY * 0.35)));
    const vx = regularize(rawVx, periodX), vy = regularize(rawVy, periodY);

    const isGrid = new Uint8Array(N);
    for (const x of rawVx) for (let y = 0; y < H; y++) for (let k = -3; k <= 3; k++) { const xx = x + k; if (xx >= 0 && xx < W) isGrid[y * W + xx] = 1; }
    for (const y of rawVy) for (let x = 0; x < W; x++) for (let k = -3; k <= 3; k++) { const yy = y + k; if (yy >= 0 && yy < H) isGrid[yy * W + x] = 1; }

    const grad = new Uint8Array(N);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1] + gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
      const gy = -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1] + gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
      grad[i] = Math.min(255, Math.hypot(gx, gy) / 4);
    }

    const x0 = Math.floor(W * 0.12), x1 = Math.ceil(W * 0.88);
    const y0 = Math.floor(H * 0.12), y1 = Math.ceil(H * 0.92);
    let fg = new Uint8Array(N);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (isGrid[i]) continue;
      if (grad[i] > 42 || gray[i] < 78) fg[i] = 1;
    }
    fg = maxFilter(fg, W, H, 2); fg = maxFilter(fg, W, H, 2);
    fg = minFilter(fg, W, H, 2); fg = minFilter(fg, W, H, 1);

    /* connected components */
    const label = new Int32Array(N).fill(-1);
    const comps = [];
    const qx = new Int32Array(N), qy = new Int32Array(N);
    let next = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const i0 = sy * W + sx;
      if (!fg[i0] || label[i0] !== -1) continue;
      let head = 0, tail = 0; qx[tail] = sx; qy[tail] = sy; tail++; label[i0] = next;
      let area = 0, minx = sx, maxx = sx, miny = sy, maxy = sy, sumx = 0, sumy = 0;
      while (head < tail) {
        const x = qx[head], y = qy[head]; head++;
        area++; sumx += x; sumy += y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [nx, ny] of nb) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const ni = ny * W + nx;
          if (fg[ni] && label[ni] === -1) { label[ni] = next; qx[tail] = nx; qy[tail] = ny; tail++; }
        }
      }
      comps.push({ id: next, area, minx, maxx, miny, maxy, cx: sumx / area, cy: sumy / area });
      next++;
    }
    comps.sort((a, b) => b.area - a.area);
    const cands = comps.filter((c) => {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1;
      if (c.area < N * 0.0015) return false;
      if (w < periodX * 0.5 || h < periodY * 0.5) return false;
      if (w > W * 0.7 || h > H * 0.7) return false;
      if (c.minx <= x0 + 2 || c.miny <= y0 + 2 || c.maxx >= x1 - 3 || c.maxy >= y1 - 3) return false;
      return true;
    });
    const centerX = W / 2, centerY = H / 2;
    cands.sort((a, b) => {
      const sa = a.area * (1 - 0.5 * Math.min(1, Math.hypot(a.cx - centerX, a.cy - centerY) / Math.hypot(W, H) * 2));
      const sb = b.area * (1 - 0.5 * Math.min(1, Math.hypot(b.cx - centerX, b.cy - centerY) / Math.hypot(W, H) * 2));
      return sb - sa;
    });
    const obj = cands[0] || null;
    let box = null;
    let grownFlag = false;
    if (obj) {
      const bw0 = obj.maxx - obj.minx + 1, bh0 = obj.maxy - obj.miny + 1;
      // Narrow strip + bright metal: grow through weak edges (hysteresis) to capture the full object.
      if (bw0 / bh0 < 0.6) {
        const weak = new Uint8Array(N);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          if (isGrid[i]) continue;
          const delta = Math.max(Math.abs(R[i] - pr), Math.abs(G[i] - pg), Math.abs(B[i] - pb));
          if (grad[i] > 24 || gray[i] < 105 || delta > 26) weak[i] = 1;
        }
        const ex0 = Math.max(x0, obj.minx - Math.round(bw0 * 0.4));
        const ex1 = Math.min(x1 - 1, obj.maxx + Math.round(bw0 * 2.2));
        const ey0 = Math.max(y0, obj.miny - Math.round(bh0 * 0.2));
        const ey1 = Math.min(y1 - 1, obj.maxy + Math.round(bh0 * 0.2));
        const grown = new Uint8Array(N);
        const qx2 = new Int32Array(N), qy2 = new Int32Array(N);
        let head = 0, tail = 0;
        for (let y = obj.miny; y <= obj.maxy; y++) for (let x = obj.minx; x <= obj.maxx; x++) {
          const i = y * W + x;
          if (label[i] === obj.id) { grown[i] = 1; qx2[tail] = x; qy2[tail] = y; tail++; }
        }
        while (head < tail) {
          const x = qx2[head], y = qy2[head]; head++;
          for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            if (nx < ex0 || nx > ex1 || ny < ey0 || ny > ey1) continue;
            const ni = ny * W + nx;
            if (!grown[ni] && (weak[ni] || fg[ni])) { grown[ni] = 1; qx2[tail] = nx; qy2[tail] = ny; tail++; }
          }
        }
        let minx = obj.minx, maxx = obj.maxx, miny = obj.miny, maxy = obj.maxy;
        for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) {
          if (!grown[y * W + x]) continue;
          if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
        if (maxx - minx + 1 > bw0 * 1.15) {
          grownFlag = true;
          box = { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
        }
      }
      if (!box) box = { x: obj.minx, y: obj.miny, w: obj.maxx - obj.minx + 1, h: obj.maxy - obj.miny + 1, cx: obj.cx, cy: obj.cy };
    } else {
      const bw = Math.round(W * 0.3), bh = Math.round(H * 0.3);
      box = { x: Math.round((W - bw) / 2), y: Math.round((H - bh) / 2), w: bw, h: bh, cx: W / 2, cy: H / 2 };
    }
    const lx = localPeriod(vx, box.cx) || periodX;
    const ly = localPeriod(vy, box.cy) || periodY;
    const wCm = lx ? box.w / lx : 0;
    const dCm = ly ? box.h / ly : 0;
    const skew = lx && ly && periodX && periodY ? Math.max(lx / periodX, ly / periodY, periodX / lx, periodY / ly) : 1;
    let confidence = "high";
    if (!gridOk || !obj) confidence = "low";
    else if (skew > 1.12 || obj.area < N * 0.004 || box.w < periodX * 1.0 || box.h < periodY * 1.0 || grownFlag) confidence = "medium";
    if (obj && box.w / box.h < 0.6) confidence = "low";
    const note = !gridOk ? "格線偵測失敗，請人手拉框或用 AI"
      : !obj ? "搵唔到物件，請人手拉框或用 AI"
      : grownFlag ? "亮面/反光件已自動擴展框，請確認"
      : skew > 1.12 ? "透視/近大遠小偏差較大，請確認"
      : "自動框只作起點，請人手確認";
    return {
      W, H, periodX, periodY, localX: +lx.toFixed(1), localY: +ly.toFixed(1),
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      wCm: +wCm.toFixed(2), dCm: +dCm.toFixed(2),
      confidence, note,
      gridOk, objectOk: !!obj,
      vx, vy,
    };
  }

  window.GridMeasure = { analyze, MAX_SIDE };
})();
