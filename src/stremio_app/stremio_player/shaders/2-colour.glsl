// Picture 2/3: colour correction.
// White balance, brightness, shadow lift, soft S-curve contrast and saturation.
// Every value is set live from the Picture menu (glsl-shader-opts).

//!PARAM WARMTH
//!DESC Positive removes a blue cast, negative a yellow cast
//!TYPE DYNAMIC float
//!MINIMUM -0.5
//!MAXIMUM 0.5
0.18

//!PARAM TINT
//!DESC Positive adds magenta (fixes green), negative adds green
//!TYPE DYNAMIC float
//!MINIMUM -0.3
//!MAXIMUM 0.3
0.02

//!PARAM BRIGHTNESS
//!DESC Overall exposure
//!TYPE DYNAMIC float
//!MINIMUM -0.5
//!MAXIMUM 0.5
0.0

//!PARAM CONTRAST
//!DESC Soft S-curve; black and white stay fixed
//!TYPE DYNAMIC float
//!MINIMUM -0.5
//!MAXIMUM 0.8
0.15

//!PARAM SHADOWS
//!DESC Positive lifts dark areas, negative deepens them
//!TYPE DYNAMIC float
//!MINIMUM -0.4
//!MAXIMUM 0.6
0.05

//!PARAM SATURATION
//!DESC 1 = unchanged
//!TYPE DYNAMIC float
//!MINIMUM 0.0
//!MAXIMUM 2.0
1.08

//!HOOK MAIN
//!BIND HOOKED
//!DESC picture: colour

vec4 hook()
{
    vec4 color = HOOKED_tex(HOOKED_pos);
    vec3 rgb = clamp(color.rgb, 0.0, 1.0);
    const vec3 lw = vec3(0.2126, 0.7152, 0.0722);
    float luma_before = dot(rgb, lw);

    // White balance: red up / blue down for warmth, green down for magenta tint.
    rgb *= vec3(1.0 + WARMTH, 1.0 - TINT, 1.0 - WARMTH);
    rgb *= luma_before / max(dot(rgb, lw), 1e-4);
    rgb = clamp(rgb, 0.0, 1.0);

    // Exposure.
    rgb = clamp(rgb * (1.0 + BRIGHTNESS), 0.0, 1.0);

    // Shadow lift: a gamma tweak that mostly affects dark tones, endpoints fixed.
    rgb = pow(rgb, vec3(1.0 / max(1.0 + SHADOWS, 0.05)));

    // Soft S-curve contrast (smoothstep keeps 0 and 1 fixed). Negative flattens.
    rgb = mix(rgb, rgb * rgb * (3.0 - 2.0 * rgb), CONTRAST);

    // Saturation around luma.
    float luma = dot(rgb, lw);
    rgb = mix(vec3(luma), rgb, SATURATION);

    return vec4(clamp(rgb, 0.0, 1.0), color.a);
}
