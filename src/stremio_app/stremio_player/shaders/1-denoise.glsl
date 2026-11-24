// Picture 1/3: edge-preserving denoise (bilateral filter).
// Smooths grain and compression blotches while keeping edges.
// DENOISE is set live from the Picture menu (glsl-shader-opts).

//!PARAM DENOISE
//!DESC How different two pixels may be and still get averaged (0 = off)
//!TYPE DYNAMIC float
//!MINIMUM 0.0
//!MAXIMUM 0.15
0.04

//!HOOK MAIN
//!BIND HOOKED
//!DESC picture: denoise

#define RADIUS 2
#define SPATIAL_SIGMA 1.6

vec4 hook()
{
    vec4 center = HOOKED_tex(HOOKED_pos);
    if (DENOISE < 0.001)
        return center;

    vec3 sum = vec3(0.0);
    float total = 0.0;
    float spatial = 2.0 * SPATIAL_SIGMA * SPATIAL_SIGMA;
    float range = 2.0 * DENOISE * DENOISE;

    for (int y = -RADIUS; y <= RADIUS; y++) {
        for (int x = -RADIUS; x <= RADIUS; x++) {
            vec3 s = HOOKED_texOff(vec2(float(x), float(y))).rgb;
            vec3 d = s - center.rgb;
            float w = exp(-float(x * x + y * y) / spatial - dot(d, d) / range);
            sum += s * w;
            total += w;
        }
    }

    return vec4(sum / total, center.a);
}
