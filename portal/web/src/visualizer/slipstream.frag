// Fly between machined octagonal ribs. Project each aperture onto its own
// depth plane, front to back; the first lip or inner wall blocks the rest.
vec2 bore(float z) {
  return vec2(.82 * sin(.19 * z + uSeed * 7.0), .48 * sin(.26 * z + 1.8 + uSeed));
}
vec2 faceNormal(vec2 p) {
  vec2 a = abs(p);
  if ((a.x + a.y) * .707107 > max(a.x, a.y)) return sign(p) * .707107;
  return a.x > a.y ? vec2(sign(p.x), 0) : vec2(0, sign(p.y));
}
float octagon(vec2 p) {
  vec2 a = abs(p);
  return max(max(a.x, a.y), (a.x + a.y) * .707107);
}

void main() {
  const vec3 teal = vec3(.14, .57, .57), copper = vec3(1.0, .32, .075);
  const vec3 enamel = vec3(.71, .81, .76), lamp = vec3(1.0, .84, .57);
  float travel = uDrive * .90 + uSeed * 10.0;
  vec2 eye = bore(travel);
  vec2 slope = rot(.09 * sin(uTime * .18)) * coord() * 1.65 + (bore(travel + 4.0) - eye) * .25;
  vec2 opening = slope - (bore(travel + 16.0) - eye) / 16.0;
  vec3 mist = mix(vec3(.048, .17, .19), vec3(.83, .92, .80), exp(-length(opening) * 10.0));
  vec3 col = mist;
  for (int i = 0; i < 24; i++) {
    float serial = floor(travel) + float(i) + 1.0;
    float z = serial - travel;
    mat2 twist = rot(.18 * serial + .18 * sin(.27 * serial));
    vec2 ray = twist * slope;
    vec2 at = twist * (eye + z * slope - bore(serial));
    float rim = 1.36 + .07 * sin(.71 * serial) - .10 * uB[int(mod(serial, 16.0))];
    float front = octagon(at) - rim;
    vec2 farEdge = at + ray * .38;
    float back = octagon(farEdge) - rim;
    if (max(front, back) < 0.0) continue;

    bool wall = front < 0.0;
    float depth = wall ? clamp(-front / max(back - front, .0001), 0.0, 1.0) : 0.0;
    vec2 point = mix(at, farEdge, depth);
    vec2 n = faceNormal(point);
    float along = dot(point, vec2(-n.y, n.x));
    float across = abs(along) / rim;
    float px = max(.001, 1.65 * z / uRes.y);
    float light = .62 + .30 * dot(transpose(twist) * n, vec2(-.65, .75));
    bool painted = mod(serial, 4.0) < 1.0;
    vec3 metal = painted ? copper : mix(enamel, uC[0], .10);
    if (wall) {
      // Cool recessed metal behind the warm bevel of the ring.
      col = mix(vec3(.025, .085, .095), teal, .27 * light + .25 * depth);
      col += teal * .44 * exp(-depth * 5.0);
    } else {
      float lip = 1.0 - smoothstep(.035 - px, .055 + px, front);
      float groove = exp(-abs(front - .119) / (.009 + px));
      float gasket = smoothstep(.19 - px, .25 + px, front);
      col = metal * light * (1.0 - .53 * groove) + enamel * lip * .32;
      col = mix(col, mix(vec3(.045, .10, .11), teal, .16), gasket);
      float cut = abs(across - .31) * rim;
      col *= 1.0 - .48 * exp(-cut / (.006 + px));
      // Rivets in the faceplate, a pair per facet.
      float rivet = length(vec2(cut - .037, front - .079));
      col = mix(col, vec3(.08, .12, .13), 1.0 - smoothstep(.009, .014 + px, rivet));
    }
    // Inset strips are broken at the corners. Treble lights their centers;
    // every fourth rib carries a copper band and a warmer lamp.
    float edge = wall ? depth * .38 : front;
    float strip = exp(-abs(edge - .018) / (.012 + px));
    float panel = 1.0 - smoothstep(.23, .28, across);
    col += (painted ? lamp : vec3(.63, .99, .91)) * strip * panel * (.57 + .45 * uF.z + .20 * uBeat.x);
    col = mix(mist, col, exp(-.060 * z));
    break;
  }
  outColor = vec4(col * vignette(coord()), 1.0);
}
