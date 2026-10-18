import { mixOklab } from '../art';
import { neon } from '../skin';
import { H as SKY_H, W as SKY_W, skyline } from '../components/Overdrive';
import { alternate, dataTexture, polygonPath, slice, texture, type LookScene } from './shared';

// Overdrive: the cover-tinted sunset, the sliced sun, the angular skyline and the rolling neon floor
// (overdrive.css), shaded in one pass. Boxes and fades come from the unpainted .od-* elements.
const sunset = '#ff8a4c';

const glsl = `
uniform float uHA, uSkyA, uLineA, uFloorA;
uniform vec4 uSun, uLine, uFloor;
uniform vec2 uSunP, uGrid;
uniform int uWinN;
uniform sampler2D uLineT;

void scenery(inout vec3 col, vec2 p) {
  if (uHA <= 0.0) return;
  vec4 g = vec4(0);
  float horizon = uFloor.y; float sunX = uSun.x;
  if (p.y < horizon) {
    vec4 s = vec4(0);
    over(s, uC[5].rgb, uC[5].a * clamp((p.y / horizon - .35) / .65, 0.0, 1.0));
    float e = length((p - vec2(sunX, horizon)) / vec2(.42 * uSize.x, .6 * horizon));
    over(s, uC[4].rgb, uC[4].a * clamp(1.0 - e / .72, 0.0, 1.0));
    over(s, vec3(0), scan(p.y));
    place(g, s, uSkyA);
  }
  if (uSunP.x > 0.0) {
    vec2 q = (p - uSun.xy) / uSun.zw; float r = length(q); float fr = fwidth(r);
    float inside = 1.0 - smoothstep(1.0 - fr, 1.0 + fr, r);
    if (inside > 0.0) {
      // The classic sliced sun: cuts widen as it sinks.
      float v = (q.y + 1.0) * .5; float fv = fwidth(v);
      float cut = cover(v, .48, .505, fv) + cover(v, .58, .615, fv) + cover(v, .675, .72, fv) + cover(v, .77, .825, fv) + cover(v, .865, .93, fv);
      vec3 c = v < .5 ? mix(uC[6].rgb, uC[7].rgb, clamp((v - .06) / .44, 0.0, 1.0)) : mix(uC[7].rgb, uC[8].rgb, clamp((v - .5) / .36, 0.0, 1.0));
      c *= 1.0 - scan(p.y);
      if (uSunP.y > 0.0 && g.a > 0.0) { vec3 b = g.rgb / g.a; c = mix(c, 1.0 - (1.0 - c) * (1.0 - b), g.a); }
      over(g, c, inside * (1.0 - cut) * uSunP.x);
    }
  }
  vec2 uv = (p - uLine.xy) / uLine.zw;
  if (uLineA > 0.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    vec3 m = texture(uLineT, uv).rgb; vec4 l = vec4(0);
    over(l, uC[9].rgb, uC[9].a * m.r); over(l, uC[10].rgb, m.g); over(l, uC[11].rgb, uC[11].a * m.b);
    vec2 w = uv * vec2(${SKY_W}.0, ${SKY_H}.0); vec2 fw = fwidth(w);
    for (int i = 0; i < uWinN; i++) {
      vec4 win = datum(i, 0);
      float cov = cover(w.x, win.x, win.x + 5.0, fw.x) * cover(w.y, win.y, win.y + 2.0, fw.y);
      if (cov > 0.0) over(l, uC[12].rgb, blink(win.z) * cov);
    }
    place(g, l, uLineA);
  }
  float y = p.y - uFloor.y; float x = p.x - uFloor.x;
  if (uFloorA > 0.0 && y >= 0.0 && x >= 0.0 && x <= uFloor.z) {
    float f = y / uFloor.w;
    vec4 fl = vec4(f < .4 ? mix(uC[13].rgb, uC[14].rgb, f / .4) : mix(uC[14].rgb, uC[0].rgb, clamp((f - .4) / .5, 0.0, 1.0)), 1.0);
    fl.rgb *= 1.0 - scan(p.y);
    // The rolling plane: 1000px of 72px cells tilted 80deg about the floor's bottom edge and seen
    // through a 300px perspective from the sun, as the CSS transform drew it.
    const float d = 300.0; const float cs = .173648; const float sn = .984808;
    float v = d * (uFloor.w - y) / (y * sn + d * cs);
    float u = uGrid.x + (x - uGrid.x) * (d + v * sn) / d;
    float vc = v + uGrid.y;
    if (vc < 1000.0 && u > -uFloor.z && u < 2.0 * uFloor.z) {
      float mask = clamp(((1000.0 - vc) / 1000.0 - .08) / .52, 0.0, 1.0);
      float fu = fwidth(u); float fvc = fwidth(vc);
      float du = abs(mod(u - (uFloor.z * .5 - 36.0) - 1.0 + 36.0, 72.0) - 36.0);
      float dv = abs(mod(vc + 1.0 + 36.0, 72.0) - 36.0);
      float cov = max(line(du, 1.0, fu), line(dv, 1.0, fvc)) * clamp(2.0 - max(fu, fvc) / 18.0, 0.0, 1.0);
      over(fl, uC[18].rgb, uC[18].a * mask * cov);
    }
    // The rail's box-shadow (22px blur, 3px spread): an 8px strip under a Gaussian of sigma 11.
    over(fl, uC[17].rgb, uC[17].a * .29 * exp(-(y - 1.0) * (y - 1.0) / 242.0));
    if (y < 2.0) {
      float fx = x / uFloor.z;
      vec4 rail = fx < .18 ? vec4(uC[15].rgb, uC[15].a * fx / .18) : fx < .5 ? mix(uC[15], uC[16], (fx - .18) / .32) : fx < .82 ? mix(uC[16], uC[15], (fx - .5) / .32) : vec4(uC[15].rgb, uC[15].a * (1.0 - fx) / .18);
      over(fl, rail.rgb, rail.a);
    }
    place(g, fl, uFloorA);
  }
  col = col * (1.0 - g.a * uHA) + g.rgb * uHA;
}`;

export const overdrive: LookScene = {
  glsl, vignette: .4,
  matches: top => !!top.querySelector('.od-horizon'),
  colors: (accent, ground, glow) => [
    [ground, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1],
    [neon, .34], [neon, .09],
    [mixOklab('#ffe58a', accent, .28), 1], [mixOklab(accent, sunset, .88), 1], [neon, 1],
    [mixOklab(ground, glow[1], .55), .85], [mixOklab(ground, '#000000', .3), 1], [accent, .55], [mixOklab('#ffffff', accent, .8), .85],
    [mixOklab(ground, neon, .2), 1], [mixOklab(ground, glow[1], .25), 1],
    [accent, .7], [neon, .75], [neon, .45],
    [mixOklab(accent, neon, .55), .72],
  ],
  create(gl) {
    // The skyline as a coverage mask: far towers in red, near towers in green, their edge in blue.
    const far = skyline(7, .72); const near = skyline(23, 1);
    const mask = Object.assign(document.createElement('canvas'), { width: 2048, height: 192 });
    const m = mask.getContext('2d')!; m.scale(mask.width / SKY_W, mask.height / SKY_H);
    m.fillStyle = '#000'; m.fillRect(0, 0, SKY_W, SKY_H); m.globalCompositeOperation = 'lighter';
    m.fillStyle = '#f00'; m.fill(polygonPath(far.path)); m.fillStyle = '#0f0'; m.fill(polygonPath(near.path));
    m.strokeStyle = '#00f'; m.lineJoin = 'bevel'; m.lineWidth = 1.6; m.stroke(polygonPath(near.path));
    const line = texture(gl, 2, mask, { mipmap: true });
    gl.activeTexture(gl.TEXTURE3); const data = dataTexture(gl, [near.windows.map(w => [w.x, w.y, w.delay, 0])]);
    return {
      feed({ gl, u, top, scene, clock, moving, auth, performance, opacity }) {
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, line);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, data);
        gl.uniform1i(u.uLineT, 2); gl.uniform1i(u.uData, 3);
        const horizon = top.querySelector('.od-horizon')!;
        gl.uniform1f(u.uHA, opacity(horizon));
        const sun = horizon.querySelector('.od-sun')!; const sky = horizon.querySelector('.od-skyline')!; const floor = horizon.querySelector('.od-floor')!;
        const sunBox = sun.getBoundingClientRect(); const floorBox = floor.getBoundingClientRect();
        gl.uniform4f(u.uSun, sunBox.left + sunBox.width / 2, sunBox.top + sunBox.height / 2, sunBox.width / 2, sunBox.height / 2);
        // Away from the sleeve the sun screens into the sky, as its mix-blend-mode did.
        gl.uniform2f(u.uSunP, opacity(sun), !scene.classList.contains('immersive') && !auth && !performance ? 1 : 0);
        gl.uniform4f(u.uLine, ...slice(sky.getBoundingClientRect(), SKY_W, SKY_H));
        gl.uniform1f(u.uLineA, opacity(sky));
        gl.uniform4f(u.uFloor, floorBox.left, floorBox.top, floorBox.width, floorBox.height);
        gl.uniform1f(u.uFloorA, opacity(floor));
        gl.uniform2f(u.uGrid, sunBox.left + sunBox.width / 2 - floorBox.left, (clock / (auth ? 4 : 2.6) % 1) * 72);
        gl.uniform1f(u.uSkyA, moving ? 1 - .28 * alternate(clock, 7) : 1);
        gl.uniform1i(u.uWinN, near.windows.length);
        gl.uniform4f(u.uBlinkT, 9, .41, .47, .78); gl.uniform2f(u.uBlinkV, .15, .4);
      },
    };
  },
};
