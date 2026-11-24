//! Blur regions: rectangles (normalized to the video frame) that are blurred,
//! pixelated or blacked out by an mpv `lavfi` video filter.
//!
//! The web UI sends `["mpv-set-blur-regions", [region, ...]]`; the player turns the
//! list into a filter graph using the current video size and folds it into the
//! `vf` chain it already manages.

use serde::{Deserialize, Serialize};

/// Smallest region side (in video pixels) we will filter. Tiny crops break boxblur.
const MIN_SIDE: i64 = 16;
const MAX_REGIONS: usize = 16;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlurKind {
    #[default]
    Gaussian,
    Box,
    Pixelate,
    Solid,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BlurRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub kind: BlurKind,
    /// 1..=100
    #[serde(default = "default_strength")]
    pub strength: f64,
}

fn default_strength() -> f64 {
    50.0
}

/// Shared between the message thread (which receives regions from the web UI) and the
/// display thread (which rebuilds the filter chain when the video changes).
#[derive(Debug, Default)]
pub struct BlurState {
    pub regions: Vec<BlurRegion>,
    /// The `hwdec` value the web UI asked for; we may override it while filters run.
    pub requested_hwdec: Option<String>,
    /// Last values we actually applied, so we only touch mpv on change.
    pub applied_vf: Option<String>,
    pub applied_hwdec: Option<String>,
}

pub type SharedBlurState = std::sync::Arc<std::sync::Mutex<BlurState>>;

impl BlurState {
    pub fn active(&self) -> bool {
        !self.regions.is_empty()
    }

    /// Software filters cannot read GPU frames, so blur needs a copy-back decoder.
    /// The shell starts mpv with `hwdec=auto`, which is what "nothing requested" means.
    pub fn effective_hwdec(&self) -> String {
        let requested = self.requested_hwdec.as_deref().unwrap_or("auto");
        if !self.active() || requested == "no" || requested.ends_with("-copy") {
            requested.to_string()
        } else {
            "auto-copy".to_string()
        }
    }
}

struct PixelRect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

fn even(value: f64) -> i64 {
    ((value / 2.0).round() as i64) * 2
}

fn to_pixels(region: &BlurRegion, video_w: i64, video_h: i64) -> Option<PixelRect> {
    let finite = [region.x, region.y, region.w, region.h]
        .iter()
        .all(|v| v.is_finite());
    if !finite {
        return None;
    }
    let x0 = region.x.clamp(0.0, 1.0);
    let y0 = region.y.clamp(0.0, 1.0);
    let x1 = (region.x + region.w).clamp(0.0, 1.0);
    let y1 = (region.y + region.h).clamp(0.0, 1.0);
    let x = even(x0 * video_w as f64).clamp(0, video_w);
    let y = even(y0 * video_h as f64).clamp(0, video_h);
    let w = (even(x1 * video_w as f64).min(video_w) - x).max(0);
    let h = (even(y1 * video_h as f64).min(video_h) - y).max(0);
    if w < MIN_SIDE || h < MIN_SIDE {
        return None;
    }
    Some(PixelRect { x, y, w, h })
}

/// Filters applied to a cropped region (between `crop` and `overlay`).
fn region_filter(kind: BlurKind, strength: f64, rect: &PixelRect) -> String {
    let strength = if strength.is_finite() {
        strength.clamp(1.0, 100.0)
    } else {
        default_strength()
    };
    match kind {
        BlurKind::Gaussian => format!("gblur=sigma={:.2}:steps=3", strength * 0.6),
        BlurKind::Box => {
            // boxblur radius must stay under half of the (chroma) plane size.
            let luma_max = (rect.w.min(rect.h) / 2 - 1).max(1);
            let chroma_max = (rect.w.min(rect.h) / 4 - 1).max(1);
            let luma = ((strength * 0.5).round() as i64).clamp(1, luma_max);
            let chroma = (luma / 2).clamp(1, chroma_max);
            format!("boxblur={luma}:3:{chroma}:3")
        }
        BlurKind::Pixelate => {
            // strength 1..100 -> block size 4..64 px
            let block = 4.0 + (strength - 1.0) * (60.0 / 99.0);
            let small_w = ((rect.w as f64 / block).round() as i64).max(1);
            let small_h = ((rect.h as f64 / block).round() as i64).max(1);
            format!(
                "scale={small_w}:{small_h}:flags=area,scale={}:{}:flags=neighbor",
                rect.w, rect.h
            )
        }
        BlurKind::Solid => unreachable!("solid regions use drawbox"),
    }
}

/// Builds an ffmpeg filter graph for the given regions, or `None` if nothing applies.
pub fn filter_graph(regions: &[BlurRegion], video_w: i64, video_h: i64) -> Option<String> {
    if video_w <= 0 || video_h <= 0 {
        return None;
    }
    let mut blurred = Vec::new();
    let mut solid = Vec::new();
    for region in regions.iter().take(MAX_REGIONS) {
        if let Some(rect) = to_pixels(region, video_w, video_h) {
            if region.kind == BlurKind::Solid {
                solid.push(rect);
            } else {
                blurred.push((region, rect));
            }
        }
    }
    if blurred.is_empty() && solid.is_empty() {
        return None;
    }

    let mut chains = Vec::new();
    if !blurred.is_empty() {
        let mut split = format!("split={}[base0]", blurred.len() + 1);
        for index in 0..blurred.len() {
            split.push_str(&format!("[src{index}]"));
        }
        chains.push(split);
        for (index, (region, rect)) in blurred.iter().enumerate() {
            chains.push(format!(
                "[src{index}]crop={}:{}:{}:{}:exact=1,{}[blur{index}]",
                rect.w,
                rect.h,
                rect.x,
                rect.y,
                region_filter(region.kind, region.strength, rect)
            ));
        }
        for (index, (_, rect)) in blurred.iter().enumerate() {
            let last = index + 1 == blurred.len() && solid.is_empty();
            let output = if last {
                String::new()
            } else {
                format!("[base{}]", index + 1)
            };
            chains.push(format!(
                "[base{index}][blur{index}]overlay={}:{}:format=auto{output}",
                rect.x, rect.y
            ));
        }
    }
    if !solid.is_empty() {
        let boxes = solid
            .iter()
            .map(|rect| {
                format!(
                    "drawbox=x={}:y={}:w={}:h={}:color=black:t=fill",
                    rect.x, rect.y, rect.w, rect.h
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        if blurred.is_empty() {
            chains.push(boxes);
        } else {
            chains.push(format!("[base{}]{boxes}", blurred.len()));
        }
    }
    Some(chains.join(";"))
}

/// Wraps a filter graph as an mpv `vf` list entry. `%N%` quoting passes the graph
/// through mpv's option parser untouched (commas, brackets and all).
pub fn mpv_vf_entry(graph: &str) -> String {
    format!("@stremioblur:lavfi=graph=%{}%{}", graph.len(), graph)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(kind: BlurKind) -> BlurRegion {
        BlurRegion {
            x: 0.1,
            y: 0.8,
            w: 0.8,
            h: 0.15,
            kind,
            strength: 50.0,
        }
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(filter_graph(&[], 1920, 1080), None);
    }

    #[test]
    fn single_gaussian() {
        let graph = filter_graph(&[region(BlurKind::Gaussian)], 1920, 1080).unwrap();
        assert_eq!(
            graph,
            "split=2[base0][src0];[src0]crop=1536:162:192:864:exact=1,gblur=sigma=30.00:steps=3[blur0];[base0][blur0]overlay=192:864:format=auto"
        );
    }

    #[test]
    fn mixed_with_solid() {
        let graph = filter_graph(
            &[region(BlurKind::Pixelate), region(BlurKind::Solid)],
            1920,
            1080,
        )
        .unwrap();
        assert!(graph.ends_with("[base1]drawbox=x=192:y=864:w=1536:h=162:color=black:t=fill"));
        assert!(graph.contains("flags=neighbor"));
    }

    #[test]
    fn solid_only() {
        let graph = filter_graph(&[region(BlurKind::Solid)], 1920, 1080).unwrap();
        assert_eq!(graph, "drawbox=x=192:y=864:w=1536:h=162:color=black:t=fill");
    }

    #[test]
    fn tiny_regions_are_skipped() {
        let mut tiny = region(BlurKind::Box);
        tiny.w = 0.001;
        assert_eq!(filter_graph(&[tiny], 1920, 1080), None);
    }

    #[test]
    fn hwdec_override() {
        let mut state = BlurState::default();
        assert_eq!(state.effective_hwdec(), "auto");
        state.requested_hwdec = Some("d3d11va".into());
        assert_eq!(state.effective_hwdec(), "d3d11va");
        state.regions.push(region(BlurKind::Box));
        assert_eq!(state.effective_hwdec(), "auto-copy");
        state.requested_hwdec = Some("no".into());
        assert_eq!(state.effective_hwdec(), "no");
        state.requested_hwdec = Some("d3d11va-copy".into());
        assert_eq!(state.effective_hwdec(), "d3d11va-copy");
    }

    #[test]
    fn web_message_parses() {
        use crate::stremio_app::stremio_player::{InMsg, InMsgArgs, InMsgFn};
        let msg: InMsg = serde_json::from_str(
            r#"["mpv-set-blur-regions",[{"x":0.1,"y":0.8,"w":0.8,"h":0.15,"kind":"pixelate","strength":40}]]"#,
        )
        .unwrap();
        assert_eq!(msg.0, InMsgFn::MpvSetBlurRegions);
        match msg.1 {
            InMsgArgs::Regions(regions) => assert_eq!(regions[0].kind, BlurKind::Pixelate),
            other => panic!("unexpected {other:?}"),
        }
        let empty: InMsg = serde_json::from_str(r#"["mpv-set-blur-regions",[]]"#).unwrap();
        assert_eq!(empty.1, InMsgArgs::Regions(vec![]));
    }

    #[test]
    fn print_sample_graphs() {
        let mut all = vec![
            region(BlurKind::Gaussian),
            region(BlurKind::Box),
            region(BlurKind::Pixelate),
            region(BlurKind::Solid),
        ];
        for (i, r) in all.iter_mut().enumerate() {
            r.y = 0.05 + i as f64 * 0.2;
        }
        println!("GRAPH={}", filter_graph(&all, 1920, 1080).unwrap());
    }

    #[test]
    fn vf_entry_quotes_length() {
        assert_eq!(mpv_vf_entry("a,b"), "@stremioblur:lavfi=graph=%3%a,b");
    }
}
