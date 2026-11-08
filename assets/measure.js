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

  function localPeriod(p, center, globalPeriod) {
    if (p.length < 2) return 0;
    const ints = [];
    for (let i = 0; i + 1 < p.length; i++) {
      const d = p[i + 1] - p[i];
      if (d <= 20) continue;
      // Reject gaps caused by missing/false lines; they are not one grid cell.
      if (globalPeriod && (d < globalPeriod * 0.7 || d > globalPeriod * 1.3)) continue;
      ints.push({ d, mid: (p[i] + p[i + 1]) / 2 });
    }
    ints.sort((a, b) => Math.abs(a.mid - center) - Math.abs(b.mid - center));
    const take = ints.slice(0, 2);
    return take.length ? take.reduce((s, x) => s + x.d, 0) / take.length : 0;
  }

  const GRID_CM = 1;

  function solve8(A, b) {
    const n = 8;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-10) return null;
      if (p !== i) { const t = A[i]; A[i] = A[p]; A[p] = t; const tb = b[i]; b[i] = b[p]; b[p] = tb; }
      const d = A[i][i];
      for (let c = i; c < n; c++) A[i][c] /= d;
      b[i] /= d;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i];
        if (!f) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    return b.slice();
  }

  function fitGridHomography(vx, vy) {
    const nx = vx.length, ny = vy.length;
    if (nx < 4 || ny < 4) return null;
    const x0 = vx[0], x1 = vx[nx - 1], y0 = vy[0], y1 = vy[ny - 1];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const sx = (x1 - x0) / 2 || 1, sy = (y1 - y0) / 2 || 1;
    const cu = (nx - 1) / 2, cv = (ny - 1) / 2;
    const su = (nx - 1) / 2 || 1, sv = (ny - 1) / 2 || 1;
    const ATA = Array.from({ length: 8 }, () => Array(8).fill(0));
    const ATb = Array(8).fill(0);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const xn = (vx[i] - cx) / sx, yn = (vy[j] - cy) / sy;
      const un = (i - cu) / su, vn = (j - cv) / sv;
      const rows = [
        [xn, yn, 1, 0, 0, 0, -un * xn, -un * yn, un],
        [0, 0, 0, xn, yn, 1, -vn * xn, -vn * yn, vn],
      ];
      for (const row of rows) {
        for (let a = 0; a < 8; a++) {
          for (let b = 0; b < 8; b++) ATA[a][b] += row[a] * row[b];
          ATb[a] += row[a] * row[8];
        }
      }
    }
    const h = solve8(ATA, ATb);
    if (!h) return null;
    const map = (x, y) => {
      const xn = (x - cx) / sx, yn = (y - cy) / sy;
      const den = h[6] * xn + h[7] * yn + 1;
      if (Math.abs(den) < 1e-9) return null;
      const un = (h[0] * xn + h[1] * yn + h[2]) / den;
      const vn = (h[3] * xn + h[4] * yn + h[5]) / den;
      return { u: un * su + cu, v: vn * sv + cv };
    };
    let sum = 0, count = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const p = map(vx[i], vy[j]);
      if (!p) continue;
      const du = p.u - i, dv = p.v - j;
      sum += du * du + dv * dv; count++;
    }
    const rmsCell = Math.sqrt(sum / Math.max(1, count));
    let maxCellErr = 0;
    for (let i = 0; i + 1 < nx; i++) for (let j = 0; j < ny; j++) {
      const a = map(vx[i], vy[j]), b = map(vx[i + 1], vy[j]);
      if (a && b) maxCellErr = Math.max(maxCellErr, Math.abs(Math.hypot(b.u - a.u, b.v - a.v) - 1));
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j + 1 < ny; j++) {
      const a = map(vx[i], vy[j]), b = map(vx[i], vy[j + 1]);
      if (a && b) maxCellErr = Math.max(maxCellErr, Math.abs(Math.hypot(b.u - a.u, b.v - a.v) - 1));
    }
    const avgPeriod = (((vx[nx - 1] - vx[0]) / (nx - 1)) + ((vy[ny - 1] - vy[0]) / (ny - 1))) / 2;
    return { map, rmsCell, rmsPx: rmsCell * avgPeriod, maxCellErr, nx, ny, avgPeriod };
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
    const rawPX = periodX, rawPY = periodY;
    if (!periodX) periodX = periodY;
    if (!periodY) periodY = periodX;
    const spacingSkew = rawPX && rawPY ? Math.max(rawPX / rawPY, rawPY / rawPX) : 99;
    const gridOk = rawPX >= 45 && rawPX <= 130 && rawPY >= 45 && rawPY <= 130 && spacingSkew <= 1.12;

    const rawVx = peaks(scoreX, Math.max(20, Math.round(periodX * 0.35)));
    const rawVy = peaks(scoreY, Math.max(20, Math.round(periodY * 0.35)));
    const vx = regularize(rawVx, periodX), vy = regularize(rawVy, periodY);
    // 動態網格標定：格線交點 → homography（image ↔ 格座標）
    const GH = fitGridHomography(vx, vy);

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
      let area = 0, minx = sx, maxx = sx, miny = sy, maxy = sy, sumx = 0, sumy = 0, edge = 0;
      while (head < tail) {
        const x = qx[head], y = qy[head]; head++;
        area++; sumx += x; sumy += y;
        if (grad[y * W + x] > 40) edge++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [nx, ny] of nb) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const ni = ny * W + nx;
          if (fg[ni] && label[ni] === -1) { label[ni] = next; qx[tail] = nx; qy[tail] = ny; tail++; }
        }
      }
      comps.push({ id: next, area, minx, maxx, miny, maxy, cx: sumx / area, cy: sumy / area, edge, density: edge / area });
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
      // Metal/reflective items break into several edge components (threads, hex body).
      // Merge nearby *edge-dense* components only; skip smooth shadows/paper noise.
      let minx = obj.minx, maxx = obj.maxx, miny = obj.miny, maxy = obj.maxy;
      const bw0 = obj.maxx - obj.minx + 1, bh0 = obj.maxy - obj.miny + 1;
      // Long thin objects (screws, pins): do NOT merge; merging grabs shadows/paper folds.
      const longObject = Math.max(bw0 / bh0, bh0 / bw0) > 2.2;
      const gap = Math.max(bw0, bh0) * 0.45;
      if (!longObject) {
        for (const c of comps) {
          if (c === obj) continue;
          if (c.area < Math.max(150, obj.area * 0.05)) continue;
          if (c.area > obj.area * 2.5) continue;
          if ((c.density || 0) < 0.10 || (c.edge || 0) < 60) continue;
          // must overlap or be within a small gap of the main component
          if (c.maxx < obj.minx - gap || c.minx > obj.maxx + gap || c.maxy < obj.miny - gap || c.miny > obj.maxy + gap) continue;
          if (c.minx < x0 || c.maxx > x1 || c.miny < y0 || c.maxy > y1) continue;
          const cw = c.maxx - c.minx + 1, ch = c.maxy - c.miny + 1;
          if (cw > W * 0.45 || ch > H * 0.45) continue;
          minx = Math.min(minx, c.minx); maxx = Math.max(maxx, c.maxx);
          miny = Math.min(miny, c.miny); maxy = Math.max(maxy, c.maxy);
        }
      }
      if ((maxx - minx + 1) > bw0 * 1.12 || (maxy - miny + 1) > bh0 * 1.12) grownFlag = true;
      box = { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
    } else {
      const bw = Math.round(W * 0.3), bh = Math.round(H * 0.3);
      box = { x: Math.round((W - bw) / 2), y: Math.round((H - bh) / 2), w: bw, h: bh, cx: W / 2, cy: H / 2 };
    }
    // Local homography around the object (paper is not perfectly flat)
    const vxNear = vx.filter((x) => Math.abs(x - box.cx) <= periodX * 3.5);
    const vyNear = vy.filter((y) => Math.abs(y - box.cy) <= periodY * 3.5);
    const GHl = fitGridHomography(vxNear, vyNear);
    const GHuse = GHl && (!GH || GHl.rmsCell <= GH.rmsCell * 1.1) ? GHl : GH;
    const gridCalibOk = Boolean(GHuse && GHuse.rmsCell < 0.06 && GHuse.maxCellErr < 0.12);
    let lx = localPeriod(vx, box.cx, periodX) || periodX;
    let ly = localPeriod(vy, box.cy, periodY) || periodY;
    let wCm = lx ? box.w / lx : 0;
    let dCm = ly ? box.h / ly : 0;
    let homographyUsed = false;
    if (GHuse) {
      const corners = [
        { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
        { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
      ];
      const cms = corners.map((c) => GHuse.map(c.x, c.y));
      if (cms.every(Boolean)) {
        const top = Math.hypot(cms[1].u - cms[0].u, cms[1].v - cms[0].v);
        const bottom = Math.hypot(cms[2].u - cms[3].u, cms[2].v - cms[3].v);
        const left = Math.hypot(cms[3].u - cms[0].u, cms[3].v - cms[0].v);
        const right = Math.hypot(cms[2].u - cms[1].u, cms[2].v - cms[1].v);
        wCm = ((top + bottom) / 2) * GRID_CM;
        dCm = ((left + right) / 2) * GRID_CM;
        homographyUsed = true;
        lx = wCm ? box.w / wCm : lx;
        ly = dCm ? box.h / dCm : ly;
      }
    }
    if (!homographyUsed) { wCm = lx ? box.w / lx : 0; dCm = ly ? box.h / ly : 0; }
    const skew = lx && ly && periodX && periodY ? Math.max(lx / periodX, ly / periodY, periodX / lx, periodY / ly) : 1;
    let confidence = "high";
    if (!gridOk || !obj || spacingSkew > 1.12) confidence = "low";
    else if (!homographyUsed || !gridCalibOk || skew > 1.12 || obj.area < N * 0.004 || box.w < periodX * 1.0 || box.h < periodY * 1.0 || grownFlag) confidence = "medium";
    if (GHuse && GHuse.rmsCell > 0.10) confidence = "low";
    const note = !gridOk
      ? (spacingSkew > 1.12
        ? "格距 X/Y 差 " + Math.round((spacingSkew - 1) * 100) + "%，影像太斜／格線不清，請重拍"
        : "格線偵測失敗，請重拍或用 AI")
      : GHuse && !gridCalibOk
        ? "格點校正誤差大（RMS " + GHuse.rmsPx.toFixed(1) + "px），請重拍"
      : !obj ? "搵唔到物件，請人手拉框或用 AI"
      : grownFlag ? "反光件已合併附近邊緣，請確認框位"
      : skew > 1.12 ? "透視/近大遠小偏差較大，請確認"
      : "自動框只作起點，請人手確認";
    return {
      W, H, periodX, periodY, localX: +lx.toFixed(1), localY: +ly.toFixed(1),
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      wCm: +wCm.toFixed(2), dCm: +dCm.toFixed(2),
      confidence, note,
      gridOk, objectOk: !!obj, homographyUsed,
      gridCheck: GHuse ? { nx: GHuse.nx, ny: GHuse.ny, rmsPx: +GHuse.rmsPx.toFixed(1), maxCellErrPct: +(GHuse.maxCellErr * 100).toFixed(1) } : null,
      vx, vy,
    };
  }

  window.GridMeasure = { analyze, MAX_SIDE };
})();
