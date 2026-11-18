// A relief cut into parallel rock strata. Each stratum is a vertical plane
// at a different depth: its crest hides the strata behind it. The sixteen
// frequency bands lift individual ridges as the camera drifts past them.
float ridge(float x, float z, float energy) {
  float spine = x + .8 + .72 * sin(.76 * z + uSeed * 3.0);
  float shoulder = x - 2.1 + .68 * sin(z * .62);
  float mass = 1.88 / (1.0 + spine * spine * 1.28 + .18 * (z - 5.6) * (z - 5.6))
             + 1.43 / (1.0 + shoulder * shoulder + .10 * (z - 9.4) * (z - 9.4));
  float fold = .5 + .5 * sin(x * 1.9 + .72 * z + .46 * sin(x * 3.6 - z * .53));
  float crag = abs(sin(x * 4.4 + sin(z * 1.5)) + .34 * sin(x * 9.2 - z * .7));
  return .12 + mass * (.67 + .42 * energy + .20 * fold) + (.16 + .19 * energy) * fold + .08 * crag;
}

void main() {
  vec2 p = coord();
  float aspect = uRes.x / uRes.y;
  float pan = .68 * sin(.17 * uTime + uSeed * 6.0);
  vec2 slope = p * 1.34 - vec2(.055 * sin(.11 * uTime), .17);
  vec2 sun = p - vec2(.22 * min(aspect, 1.35), .235 + .014 * sin(.12 * uTime));
  float radius = .078 * min(aspect * 1.7, 1.0) * (1.0 + .09 * uF.x);
  float px = 1.0 / uRes.y;
  const vec3 mist = vec3(.80, .52, .38), ink = vec3(.027, .093, .103);
  vec3 sky = mix(mist, vec3(.15, .24, .30), smoothstep(.03, .56, p.y));
  float disc = 1.0 - smoothstep(radius - px, radius + px, length(sun));
  sky += vec3(.22, .105, .014) * exp(-10.0 * length(sun));
  sky = mix(sky, vec3(1.0, .74, .41), disc);

  vec3 col = vec3(0);
  float through = 1.0;
  for (int i = 0; i < 28; i++) {
    float z = 1.35 + .44 * float(i);
    float x = pan + z * slope.x;
    float height = 1.56 + z * slope.y;
    if (height > 3.7) break;
    float energy = uB[i % 16];
    float crest = ridge(x + .32 * sin(uDrive * .22 - z * .55), z, energy);
    float below = crest - height;
    float pixel = px * z * 1.6;
    if (below < -pixel) continue;

    float depth = float(i) / 27.0;
    vec3 face = mix(ink, vec3(.37, .46, .44), depth * depth);
    face += vec3(.030, .10, .096) * exp(-max(below, 0.0) * 4.5);
    // Fine engraved contours on the near faces dissolve into haze in the distance.
    float etch = abs(fract(below * 9.0 + .5) - .5) / 9.0;
    face += vec3(.07, .12, .12) * exp(-etch / (.004 + pixel)) * exp(-abs(below) * 5.0) * (1.0 - depth);
    vec3 lip = mix(vec3(.48, .83, .75), vec3(1.0, .79, .52), smoothstep(.45, 2.3, crest));
    lip = mix(lip, uC[0], .10) * (.78 + .17 * energy + .10 * uBeat.x);
    face = mix(face, lip, exp(-max(below, 0.0) / (.013 + .70 * pixel)));
    face = mix(face, mist, .49 * depth * depth);
    float cover = smoothstep(-pixel, pixel, below);
    col += through * cover * face;
    through *= 1.0 - cover;
    if (through < .002) break;
  }
  col += through * sky;
  col += (hash(gl_FragCoord.xy) - .5) * .013;
  outColor = vec4(col * vignette(p), 1.0);
}
