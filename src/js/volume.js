/* NavVolume: 3D HU volume with affine voxel->patient (LPS, mm) mapping, trilinear sampling and fast oblique plane rendering. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavVolume = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function inv3(a, b, c) { // columns a,b,c -> inverse rows
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
    if (Math.abs(det) < 1e-12) throw new Error('Singular voxel geometry');
    const m = [[b[1] * c[2] - b[2] * c[1], -(b[0] * c[2] - b[2] * c[0]), b[0] * c[1] - b[1] * c[0]],
      [-(a[1] * c[2] - a[2] * c[1]), a[0] * c[2] - a[2] * c[0], -(a[0] * c[1] - a[1] * c[0])],
      [a[1] * b[2] - a[2] * b[1], -(a[0] * b[2] - a[2] * b[0]), a[0] * b[1] - a[1] * b[0]]];
    return m.map((r) => r.map((v) => v / det));
  }
  class Volume {
    constructor(g) {
      this.dims = g.dims; this.data = g.data; this.origin = g.origin; this.vi = g.vi; this.vj = g.vj; this.vk = g.vk;
      this.inv = inv3(g.vi, g.vj, g.vk);
      this.spacing = [Math.hypot(...g.vi), Math.hypot(...g.vj), Math.hypot(...g.vk)];
      this.minSpacing = Math.min(...this.spacing);
      const [nx, ny, nz] = g.dims, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) for (const k of [0, nz - 1]) {
        const P = this.toPatient(i, j, k);
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[a]); hi[a] = Math.max(hi[a], P[a]); }
      }
      this.bbox = { lo, hi, centre: lo.map((v, a) => (v + hi[a]) / 2), size: lo.map((v, a) => hi[a] - v) };
      this.meta = g.info || {}; this.warnings = g.warnings || [];
    }
    toPatient(i, j, k) { const o = this.origin; return [o[0] + i * this.vi[0] + j * this.vj[0] + k * this.vk[0], o[1] + i * this.vi[1] + j * this.vj[1] + k * this.vk[1], o[2] + i * this.vi[2] + j * this.vj[2] + k * this.vk[2]]; }
    toVoxel(P) { const d = [P[0] - this.origin[0], P[1] - this.origin[1], P[2] - this.origin[2]], m = this.inv; return [m[0][0] * d[0] + m[0][1] * d[1] + m[0][2] * d[2], m[1][0] * d[0] + m[1][1] * d[1] + m[1][2] * d[2], m[2][0] * d[0] + m[2][1] * d[1] + m[2][2] * d[2]]; }
    sampleVoxel(x, y, z) {
      const [nx, ny, nz] = this.dims;
      const e = 1e-6;
      if (x < -e || y < -e || z < -e || x > nx - 1 + e || y > ny - 1 + e || z > nz - 1 + e) return NaN;
      if (x < 0) x = 0; if (y < 0) y = 0; if (z < 0) z = 0; if (x > nx - 1) x = nx - 1; if (y > ny - 1) y = ny - 1; if (z > nz - 1) z = nz - 1;
      const i = Math.min(Math.floor(x), nx - 2 < 0 ? 0 : nx - 2), j = Math.min(Math.floor(y), ny - 2), k = Math.min(Math.floor(z), nz - 2);
      const fx = x - i, fy = y - j, fz = z - k, d = this.data, sx = 1, sy = nx, sz = nx * ny, b = i + j * sy + k * sz;
      const c00 = d[b] * (1 - fx) + d[b + sx] * fx, c10 = d[b + sy] * (1 - fx) + d[b + sy + sx] * fx;
      const c01 = d[b + sz] * (1 - fx) + d[b + sz + sx] * fx, c11 = d[b + sz + sy] * (1 - fx) + d[b + sz + sy + sx] * fx;
      return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
    }
    sample(P) { const v = this.toVoxel(P); return this.sampleVoxel(v[0], v[1], v[2]); }
    /* Render a W x H plane to an RGBA Uint32 buffer. P00 = patient position of pixel (0,0); du/dv = patient step per pixel. */
    renderPlane(buf32, W, H, P00, du, dv, level, window) {
      const v00 = this.toVoxel(P00), m = this.inv;
      const sx = [m[0][0] * du[0] + m[0][1] * du[1] + m[0][2] * du[2], m[1][0] * du[0] + m[1][1] * du[1] + m[1][2] * du[2], m[2][0] * du[0] + m[2][1] * du[1] + m[2][2] * du[2]];
      const sy = [m[0][0] * dv[0] + m[0][1] * dv[1] + m[0][2] * dv[2], m[1][0] * dv[0] + m[1][1] * dv[1] + m[1][2] * dv[2], m[2][0] * dv[0] + m[2][1] * dv[1] + m[2][2] * dv[2]];
      const lo = level - window / 2, scale = 255 / Math.max(window, 1), bg = 0xFF1A1A1A;
      let p = 0;
      for (let y = 0; y < H; y++) {
        let x0 = v00[0] + y * sy[0], y0 = v00[1] + y * sy[1], z0 = v00[2] + y * sy[2];
        for (let x = 0; x < W; x++, p++) {
          const h = this.sampleVoxel(x0, y0, z0);
          if (h !== h) buf32[p] = bg;
          else { let g = (h - lo) * scale; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; buf32[p] = 0xFF000000 | (g << 16) | (g << 8) | g; }
          x0 += sx[0]; y0 += sx[1]; z0 += sx[2];
        }
      }
    }
  }
  return { Volume };
});
