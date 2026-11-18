// A cut crystal suspended in a beam. Clip a ray against seven pairs of parallel
// faces, then trace the refracted ray to the back face to light the interior.
const vec3 FACES[7] = vec3[7](
  vec3(1,0,0), vec3(0,1,0), vec3(0,0,1),
  vec3(1,1,1), vec3(-1,1,1), vec3(1,-1,1), vec3(1,1,-1)
);
struct Hit { float entry; float exitAt; vec3 front; vec3 back; };
Hit crystal(vec3 origin, vec3 ray) {
  Hit h = Hit(-1e4, 1e4, vec3(0), vec3(0));
  for (int i = 0; i < 7; i++) {
    vec3 face = FACES[i];
    float limit = i < 3 ? .83 : 1.37;
    float speed = dot(ray, face);
    float offset = dot(origin, face);
    if (abs(speed) < .00001) {
      if (abs(offset) > limit) { h.exitAt = -1e4; break; }
      continue;
    }
    float direction = sign(speed);
    float nearT = (-direction * limit - offset) / speed;
    float farT = (direction * limit - offset) / speed;
    if (nearT > h.entry) { h.entry = nearT; h.front = -direction * face; }
    if (farT < h.exitAt) { h.exitAt = farT; h.back = direction * face; }
  }
  return h;
}

vec3 spectrum(float x) {
  return .52 + .48 * cos(6.283 * (x * .79 + vec3(.03, .70, .39)));
}

// A cool ribbon light and a warm window reflected in the polished facets.
vec3 studio(vec3 ray) {
  float strip = abs(ray.y + .36 * ray.x - .22);
  float hot = 1.0 - smoothstep(.055, .085, strip);
  float window = smoothstep(.36, .51, ray.x - ray.z * .6) * (1.0 - smoothstep(.42, .52, abs(ray.y + .18)));
  return vec3(.022, .033, .081) + vec3(.30, .48, .82) * exp(-strip * 5.0)
    + vec3(1.7, 2.4, 2.6) * hot + vec3(2.1, 1.17, .85) * window;
}

void main() {
  float scale = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - .5 * uRes) / scale;
  // The middle of the beam stays inside the crystal; the bass opens its fan
  // and each of the sixteen bands lights a different filament.
  vec2 beam = rot(-.16) * p;
  float width = .036 + max(beam.x, 0.0) * (.29 + .23 * uF.x);
  float lane = beam.y / width + .18 * sin(3.0 * beam.x - .23 * uTime);
  float hue = clamp(.5 + .5 * lane, 0.0, 1.0);
  float power = band(hue);
  float filament = .5 + .5 * cos(PI * 16.0 * lane);
  float fan = (1.0 - smoothstep(.85, 1.12, abs(lane))) * smoothstep(.01, .25, beam.x);
  vec3 col = mix(vec3(.022, .024, .059), uC[1], .18);
  col += vec3(.075, .076, .17) * exp(-2.9 * length(p));
  col += spectrum(hue) * fan * (.16 + .26 * power + .38 * power * filament * filament) * exp(-.68 * beam.x);
  float incoming = exp(-abs(beam.y) / (.003 + 1.0 / scale)) + .23 * exp(-abs(beam.y) * 56.0);
  col += vec3(.74, .91, 1.0) * incoming * (.58 + .24 * uBeat.x) * (1.0 - smoothstep(-.1, .1, beam.x));

  float yaw = .45 + uSeed * 2.0 + uDrive * .18;
  float tilt = .39 + .24 * sin(.24 * uTime + uSeed);
  mat3 turn = mat3(cos(yaw),0,sin(yaw), 0,1,0, -sin(yaw),0,cos(yaw));
  mat3 lean = mat3(1,0,0, 0,cos(tilt),sin(tilt), 0,-sin(tilt),cos(tilt));
  mat3 worldToGem = turn * lean;
  vec3 origin = worldToGem * vec3(0.0, .035 * sin(.45 * uTime), 3.65);
  vec3 ray = worldToGem * normalize(vec3(rot(.12) * p, -1.12 - .07 * uF.x));
  // Most of a wide screen sees only the light around the crystal.
  if (length(cross(origin, ray)) < 1.12) {
    Hit h = crystal(origin, ray);
    if (h.entry < h.exitAt) {
      vec3 surface = origin + h.entry * ray;
      vec3 normal = normalize(h.front);
      vec3 inside = refract(ray, normal, 1.0 / 1.51);
      Hit rear = crystal(surface * .99998, inside);
      vec3 exitPoint = surface + rear.exitAt * inside;
      vec3 back = normalize(rear.back);
      vec3 bounce = reflect(inside, back);
      Hit second = crystal(exitPoint * .99998, bounce);
      mat3 toWorld = transpose(worldToGem);
      vec3 reflected = toWorld * reflect(ray, normal);
      vec3 returned = toWorld * reflect(bounce, normalize(second.back));
      vec3 transmitted = toWorld * refract(inside, -back, 1.51);

      // At a grazing angle the rear facet becomes a mirror, revealing a second
      // set of cuts. The longer path through the glass separates the colors.
      float mirrored = 1.0 - smoothstep(.75, .90, dot(inside, back));
      float path = rear.exitAt + second.exitAt * mirrored;
      vec3 tint = spectrum(.56 + .38 * sin(path * 2.4 + exitPoint.x + uSeed * PI));
      vec3 interior = mix(studio(transmitted + .24 * exitPoint), studio(returned + .28 * exitPoint), mirrored);
      vec3 body = interior * mix(vec3(.62, .82, .98), tint, .61) + tint * (.12 + .10 * power);
      float sheet = abs(dot(exitPoint, vec3(-.18, .92, .35)) + .05);
      body += mix(tint, vec3(.74, .92, 1.0), .34) * exp(-sheet * 18.0) * (.58 + .45 * uF.z);
      float fresnel = pow(1.0 - clamp(dot(-ray, normal), 0.0, 1.0), 3.0);
      vec3 gem = body + studio(reflected) * (.28 + .57 * fresnel);
      vec3 a = abs(surface);
      float diagonal = 1.37 - (a.x + a.y + a.z);
      float edge = dot(h.front, h.front) < 1.5 ? diagonal * .58
        : min(.83 - max(a.x, max(a.y, a.z)), min(a.x, min(a.y, a.z)));
      gem += vec3(.70, .95, 1.0) * exp(-max(0.0, edge) / (.004 + 1.6 / scale));
      col = mix(col, 1.0 - exp(-1.35 * gem), smoothstep(0.0, 5.0 / scale, h.exitAt - h.entry));
    }
  }
  outColor = vec4(col * vignette(coord()), 1.0);
}
