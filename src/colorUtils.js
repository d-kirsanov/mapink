/**
 * src/colorUtils.js
 *
 * Colour utilities using the OKLab perceptual colour space (Björn Ottosson, 2020).
 * OKLab is approximately perceptually uniform, meaning equal Euclidean distances
 * in L/a/b correspond to equal perceived colour differences — much better than
 * raw RGB or HSL for "how different do these colours look?" questions.
 *
 * OKLab channels:
 *   L  — lightness, 0 (black) … 1 (white)
 *   a  — green (−) … red (+),   roughly −0.4 … +0.4 in gamut
 *   b  — blue  (−) … yellow (+), roughly −0.4 … +0.4 in gamut
 *
 * Reference: https://bottosson.github.io/posts/oklab/
 */

(function (MapEditor) {
  'use strict';

  // ── sRGB ↔ OKLab conversion ───────────────────────────────────────────────

  /**
   * sRGB hex string → OKLab {L, a, b}.
   * @param {string} hex  e.g. '#4a90d9'
   * @returns {{L:number, a:number, b:number}}
   */
  function hexToOklab(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return _linearRgbToOklab(_srgbToLinear(r), _srgbToLinear(g), _srgbToLinear(b));
  }

  /**
   * OKLab {L, a, b} → sRGB hex string (values clamped to [0, 255]).
   * @param {number} L
   * @param {number} a
   * @param {number} b
   * @returns {string}  '#rrggbb'
   */
  function oklabToHex(L, a, b) {
    // OKLab → LMS (via inverse M2)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    // LMS → linear RGB (via inverse M1)
    const rl =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

    // Linear RGB → sRGB, clamp, format
    const toHex = (v) => {
      const srgb = v > 0.0031308
        ? 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055
        : 12.92 * v;
      return Math.max(0, Math.min(255, Math.round(srgb * 255)))
        .toString(16).padStart(2, '0');
    };
    return '#' + toHex(rl) + toHex(gl) + toHex(bl);
  }

  /** Squared Euclidean distance in OKLab. */
  function oklabDist2(c1, c2) {
    const dL = c1.L - c2.L;
    const da = c1.a - c2.a;
    const db = c1.b - c2.b;
    return dL * dL + da * da + db * db;
  }

  // ── Palette generation ────────────────────────────────────────────────────

  // Lazily-built candidate palette; generated once and cached.
  let _palette = null;

  /**
   * Build a palette of visually distinct, map-appropriate colours.
   * Colours are sampled over OKLab space constrained to:
   *   - Mid-range lightness (not too dark, not washed out)
   *   - Reasonable chroma (colourful but not garish)
   *   - Full hue coverage
   *
   * The golden-angle / Fibonacci spiral trick distributes points
   * evenly across the hue wheel.
   */
  function _buildPalette(n = 1800) {
    const candidates = [];
    const PHI = (1 + Math.sqrt(5)) / 2;  // golden ratio

    for (let i = 0; i < n; i++) {
      const t = i / n;

      // Vary lightness gently so we get both medium and medium-bright colours
      const L = 0.50 + 0.22 * Math.sin(t * Math.PI * 3.7 + 0.8);

      // Spiral hue with varying chroma
      const angle   = i * (2 * Math.PI / (PHI * PHI));
      const chroma  = 0.11 + 0.07 * Math.sin(t * Math.PI * 5.3);

      const a = Math.cos(angle) * chroma;
      const b = Math.sin(angle) * chroma;

      // Convert back to hex to verify it's within sRGB gamut
      const hex = oklabToHex(L, a, b);
      // Check no channel clipped hard (accept minor rounding artefacts)
      const { r, g, bv } = _hexToRgb255(hex);
      if (r > 0 && r < 255 && g > 0 && g < 255 && bv > 0 && bv < 255) {
        candidates.push({ hex, lab: { L, a, b } });
      }
    }
    return candidates;
  }

  /**
   * Given an array of existing object hex colours, return the hex colour
   * that is perceptually as different as possible from all of them.
   *
   * @param {string[]} existingColors  array of '#rrggbb' strings
   * @returns {string}  '#rrggbb'
   */
  function findMostDifferentColor(existingColors) {
    if (!_palette) _palette = _buildPalette();

    if (existingColors.length === 0) {
      // No neighbours yet — pick a pleasant mid-palette colour at random
      return _palette[Math.floor(Math.random() * _palette.length)].hex;
    }

    const existingLab = existingColors.map(hexToOklab);

    let bestHex  = _palette[0].hex;
    let bestDist = -Infinity;

    for (const candidate of _palette) {
      // Minimum distance to any existing colour
      let minDist = Infinity;
      for (const el of existingLab) {
        const d = oklabDist2(candidate.lab, el);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestHex  = candidate.hex;
      }
    }

    return bestHex;
  }

  // ── Miscellaneous helpers ─────────────────────────────────────────────────

  /**
   * Parse '#rrggbb' → {r, g, b} in 0–255.
   * @param {string} hex
   * @returns {{r:number, g:number, b:number}}
   */
  function hexToRgb(hex) {
    return _hexToRgb255(hex);
  }

  /**
   * Whether text placed on top of bgHex should be black or white
   * for maximum readability (WCAG relative luminance heuristic).
   *
   * @param {string} bgHex  '#rrggbb'
   * @returns {string}  '#000000' or '#ffffff'
   */
  function contrastTextColor(bgHex) {
    const { r, g, bv } = _hexToRgb255(bgHex);
    // sRGB relative luminance (approximate)
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * bv) / 255;
    return lum > 0.45 ? '#000000' : '#ffffff';
  }

  /**
   * Lighten or darken a hex colour by a fractional amount.
   * @param {string} hex
   * @param {number} amount  positive → lighten, negative → darken  (0..1 range)
   * @returns {string}
   */
  function adjustLightness(hex, amount) {
    const lab = hexToOklab(hex);
    return oklabToHex(
      Math.max(0, Math.min(1, lab.L + amount)),
      lab.a, lab.b
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _srgbToLinear(c) {
    return c > 0.04045
      ? Math.pow((c + 0.055) / 1.055, 2.4)
      : c / 12.92;
  }

  function _linearRgbToOklab(r, g, b) {
    // Linear RGB → LMS (M1)
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    // Cube root
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);

    // LMS^(1/3) → OKLab (M2)
    return {
      L:  0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a:  1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b:  0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    };
  }

  function _hexToRgb255(hex) {
    return {
      r:  parseInt(hex.slice(1, 3), 16),
      g:  parseInt(hex.slice(3, 5), 16),
      bv: parseInt(hex.slice(5, 7), 16),
    };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  MapEditor.ColorUtils = {
    hexToOklab,
    oklabToHex,
    oklabDist2,
    findMostDifferentColor,
    hexToRgb,
    contrastTextColor,
    adjustLightness,
  };

})(window.MapEditor = window.MapEditor || {});
