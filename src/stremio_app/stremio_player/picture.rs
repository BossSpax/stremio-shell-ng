//! Picture menu: built-in GPU shaders (denoise, colour, sharpen) whose parameters
//! the web UI changes live through mpv's `glsl-shader-opts`.
//!
//! The web UI sends `["mpv-set-picture", {enabled, denoise, warmth, ...}]`. Only
//! numbers cross the bridge; shader paths and option names are fixed here.

use libmpv2::Mpv;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const SHADERS: [(&str, &str); 3] = [
    ("1-denoise.glsl", include_str!("shaders/1-denoise.glsl")),
    ("2-colour.glsl", include_str!("shaders/2-colour.glsl")),
    ("3-sharpen.glsl", include_str!("shaders/3-sharpen.glsl")),
];

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct PictureSettings {
    pub enabled: bool,
    pub denoise: f64,
    pub warmth: f64,
    pub tint: f64,
    pub brightness: f64,
    pub contrast: f64,
    pub shadows: f64,
    pub saturation: f64,
    pub sharpness: f64,
}

impl Default for PictureSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            denoise: 0.04,
            warmth: 0.18,
            tint: 0.02,
            brightness: 0.0,
            contrast: 0.15,
            shadows: 0.05,
            saturation: 1.08,
            sharpness: 0.3,
        }
    }
}

fn clamped(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

impl PictureSettings {
    /// `glsl-shader-opts` value; ranges match the shaders' //!MINIMUM / //!MAXIMUM.
    pub fn shader_opts(&self) -> String {
        let d = Self::default();
        [
            ("DENOISE", clamped(self.denoise, 0.0, 0.15, d.denoise)),
            ("WARMTH", clamped(self.warmth, -0.5, 0.5, d.warmth)),
            ("TINT", clamped(self.tint, -0.3, 0.3, d.tint)),
            ("BRIGHTNESS", clamped(self.brightness, -0.5, 0.5, d.brightness)),
            ("CONTRAST", clamped(self.contrast, -0.5, 0.8, d.contrast)),
            ("SHADOWS", clamped(self.shadows, -0.4, 0.6, d.shadows)),
            ("SATURATION", clamped(self.saturation, 0.0, 2.0, d.saturation)),
            ("SHARPNESS", clamped(self.sharpness, 0.0, 1.5, d.sharpness)),
        ]
        .iter()
        .map(|(name, value)| format!("{name}={value:.4}"))
        .collect::<Vec<_>>()
        .join(",")
    }
}

/// What the user had before the menu took over (shaders from their mpv config).
#[derive(Default)]
pub struct PictureState {
    saved: Option<(String, String)>,
}

fn shader_dir() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("StremioBlur").join("shaders"))
}

/// Writes the embedded shaders to disk (refreshing them every time so they match
/// this build) and returns them as an mpv path list.
fn install_shaders() -> Result<String, String> {
    let dir = shader_dir().ok_or("no local app data folder")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for (name, source) in SHADERS {
        let path = dir.join(name);
        fs::write(&path, source).map_err(|e| e.to_string())?;
        paths.push(path.to_string_lossy().replace('\\', "/"));
    }
    Ok(paths.join(";"))
}

impl PictureState {
    pub fn apply(&mut self, mpv: &Mpv, settings: &PictureSettings) {
        if settings.enabled {
            if self.saved.is_none() {
                let shaders = match install_shaders() {
                    Ok(shaders) => shaders,
                    Err(error) => {
                        eprintln!("picture: cannot install shaders: {error}");
                        return;
                    }
                };
                // Replace (not add to) shaders from the mpv config so nothing runs twice.
                let previous = (
                    mpv.get_property::<String>("glsl-shaders").unwrap_or_default(),
                    mpv.get_property::<String>("glsl-shader-opts").unwrap_or_default(),
                );
                if let Err(error) = mpv.set_property("glsl-shaders", shaders.as_str()) {
                    eprintln!("picture: cannot set glsl-shaders: {error:?}");
                    return;
                }
                self.saved = Some(previous);
            }
            let opts = settings.shader_opts();
            if let Err(error) = mpv.set_property("glsl-shader-opts", opts.as_str()) {
                eprintln!("picture: cannot set glsl-shader-opts={opts}: {error:?}");
            }
        } else if let Some((shaders, opts)) = self.saved.take() {
            mpv.set_property("glsl-shader-opts", opts.as_str()).ok();
            if let Err(error) = mpv.set_property("glsl-shaders", shaders.as_str()) {
                eprintln!("picture: cannot restore glsl-shaders: {error:?}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opts_are_clamped_and_named() {
        let settings = PictureSettings {
            warmth: 9.0,
            sharpness: -1.0,
            ..Default::default()
        };
        let opts = settings.shader_opts();
        assert!(opts.contains("WARMTH=0.5000"));
        assert!(opts.contains("SHARPNESS=0.0000"));
        assert!(opts.starts_with("DENOISE=0.0400,"));
    }

    #[test]
    fn web_message_parses_with_missing_fields() {
        use crate::stremio_app::stremio_player::{InMsg, InMsgArgs, InMsgFn};
        let msg: InMsg =
            serde_json::from_str(r#"["mpv-set-picture",{"enabled":true,"warmth":0.25}]"#).unwrap();
        assert_eq!(msg.0, InMsgFn::MpvSetPicture);
        match msg.1 {
            InMsgArgs::Picture(p) => {
                assert!(p.enabled);
                assert_eq!(p.warmth, 0.25);
                assert_eq!(p.sharpness, 0.3);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn every_shader_declares_its_params() {
        let all: String = SHADERS.iter().map(|(_, s)| *s).collect();
        for name in PictureSettings::default()
            .shader_opts()
            .split(',')
            .map(|kv| kv.split('=').next().unwrap().to_string())
        {
            assert!(
                all.lines().any(|line| line.trim_end() == format!("//!PARAM {name}")),
                "missing {name}"
            );
        }
    }

    /// Renders a test pattern on the GPU with the shaders and checks mpv's log for
    /// shader errors. Opens a small window for a few seconds, so it is opt-in:
    /// `cargo test gpu_render -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn gpu_render_compiles_shaders() {
        let log = std::env::temp_dir().join("stremioblur-shader-test.log");
        let shot = std::env::temp_dir().join("stremioblur-shader-test.png");
        let _ = fs::remove_file(&log);
        let mpv = Mpv::with_initializer(|init| {
            init.set_property("vo", "gpu-next")?;
            init.set_property("gpu-context", "d3d11")?;
            init.set_property("geometry", "640x360")?;
            init.set_property("log-file", log.to_string_lossy().as_ref())?;
            init.set_property("msg-level", "all=v")?;
            init.set_property("ao", "null")?;
            Ok(())
        })
        .unwrap();
        let mut state = PictureState::default();
        state.apply(
            &mpv,
            &PictureSettings {
                enabled: true,
                denoise: 0.08,
                sharpness: 0.8,
                ..Default::default()
            },
        );
        mpv.command("loadfile", &["av://lavfi:testsrc2=size=640x360:rate=25"])
            .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(3));
        // Change a value live, as the menu does.
        mpv.set_property("glsl-shader-opts", "WARMTH=-0.3,CONTRAST=0.5").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        mpv.command("screenshot-to-file", &[shot.to_string_lossy().as_ref(), "window"])
            .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        drop(mpv);
        let text = fs::read_to_string(&log).unwrap();
        // Error/fatal log lines, or a shader compile that did not succeed.
        let relevant: Vec<&str> = text
            .lines()
            .filter(|l| {
                l.contains("][e][")
                    || l.contains("][f][")
                    || (l.contains("compile status") && !l.contains("'success'"))
            })
            .collect();
        println!("LOG={}", log.display());
        println!("SHOT={}", shot.display());
        let hooks = text.lines().filter(|l| l.contains("picture:")).count();
        println!("HOOK_LINES={hooks}");
        assert!(relevant.is_empty(), "shader problems:\n{}", relevant.join("\n"));
        assert!(hooks > 0, "shaders never appeared in the render log");
    }

    /// Loads the real shaders into libmpv to catch syntax errors in the PARAM blocks.
    #[test]
    fn mpv_accepts_shaders_and_opts() {
        let mpv = Mpv::new().unwrap();
        let mut state = PictureState::default();
        mpv.set_property("glsl-shaders", "C:/user/own.glsl").unwrap();
        state.apply(
            &mpv,
            &PictureSettings {
                enabled: true,
                ..Default::default()
            },
        );
        let active = mpv.get_property::<String>("glsl-shaders").unwrap();
        assert!(active.contains("1-denoise.glsl") && !active.contains("own.glsl"));
        assert!(mpv
            .get_property::<String>("glsl-shader-opts")
            .unwrap()
            .contains("CONTRAST=0.1500"));
        state.apply(&mpv, &PictureSettings::default());
        assert_eq!(
            mpv.get_property::<String>("glsl-shaders").unwrap(),
            "C:/user/own.glsl"
        );
    }
}
