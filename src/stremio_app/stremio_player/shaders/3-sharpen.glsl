// Picture 3/3: halo-free adaptive sharpen.
// - Sharpens brightness only, so edges don't get coloured fringes.
// - Sharpens soft detail more and already-crisp edges less.
// - Never lets a pixel go brighter/darker than its neighbours (no halos).
// SHARPNESS is set live from the Picture menu (glsl-shader-opts).

//!PARAM SHARPNESS
//!DESC 0 = off, 0.3 = light, 0.6 = medium, 1 = strong
//!TYPE DYNAMIC float
//!MINIMUM 0.0
//!MAXIMUM 1.5
0.3

//!HOOK MAIN
//!BIND HOOKED
//!DESC picture: sharpen

vec4 hook()
{
    const vec3 lw = vec3(0.2126, 0.7152, 0.0722);
    vec4 color = HOOKED_tex(HOOKED_pos);
    if (SHARPNESS < 0.001)
        return color;
    float c = dot(color.rgb, lw);
    float n = dot(HOOKED_texOff(vec2(0.0, -1.0)).rgb, lw);
    float w = dot(HOOKED_texOff(vec2(-1.0, 0.0)).rgb, lw);
    float e = dot(HOOKED_texOff(vec2(1.0, 0.0)).rgb, lw);
    float s = dot(HOOKED_texOff(vec2(0.0, 1.0)).rgb, lw);

    float lo = min(c, min(min(n, w), min(e, s)));
    float hi = max(c, max(max(n, w), max(e, s)));

    // Less sharpening where local contrast is already high.
    float amount = sqrt(clamp(min(lo, 1.0 - hi) / max(hi, 1e-4), 0.0, 1.0));
    float detail = c - (n + w + e + s) * 0.25;
    float sharpened = c + detail * amount * SHARPNESS * 2.0;

    // Anti-halo: stay within the neighbourhood's own range.
    sharpened = clamp(sharpened, lo, hi);

    return vec4(clamp(color.rgb + (sharpened - c), 0.0, 1.0), color.a);
}
