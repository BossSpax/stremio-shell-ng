// Blur regions for the Stremio player (injected by the forked shell).
// Draw rectangles over the video; the shell blurs them inside mpv with ffmpeg filters.
// Settings live in localStorage under our own key; nothing else is read.
(function () {
    'use strict';
    if (window.top !== window.self || window.__stremioBlurRegions) return;
    window.__stremioBlurRegions = true;

    var STORAGE_KEY = 'stremioBlurRegions.v1';
    var KINDS = [
        ['gaussian', 'Gaussian blur'],
        ['box', 'Box blur (frosted)'],
        ['pixelate', 'Pixelate'],
        ['solid', 'Solid black']
    ];
    var MIN_SIZE = 0.01;

    // ---------- state ----------
    var state = load();
    var editing = false;
    var panelOpen = false;
    var selectedId = null;
    var videoInfo = null; // { osd: {w,h,ml,mt,mr,mb}, width, height }
    var lastSentJson = null;
    var sendTimer = null;

    // ---------- picture (shader) settings ----------
    var PICTURE_KEY = 'stremioPicture.v1';
    var PICTURE_SLIDERS = [
        // key, label, min, max, step, neutral
        ['denoise', 'Denoise', 0, 0.15, 0.005, 0],
        ['sharpness', 'Sharpen', 0, 1.5, 0.05, 0],
        ['warmth', 'Warmth', -0.5, 0.5, 0.01, 0],
        ['tint', 'Tint (green ↔ magenta)', -0.3, 0.3, 0.01, 0],
        ['brightness', 'Brightness', -0.5, 0.5, 0.01, 0],
        ['contrast', 'Contrast', -0.5, 0.8, 0.01, 0],
        ['shadows', 'Shadows', -0.4, 0.6, 0.01, 0],
        ['saturation', 'Saturation', 0, 2, 0.01, 1]
    ];
    var CAM_FIX = {
        denoise: 0.04, sharpness: 0.3, warmth: 0.18, tint: 0.02,
        brightness: 0, contrast: 0.15, shadows: 0.05, saturation: 1.08
    };
    var picture = loadPicture();
    var picturePanelOpen = false;
    var pictureTimer = null;
    var pictureHeld = false; // "hold to compare" shows the original picture

    function loadPicture() {
        var result = { enabled: false };
        Object.keys(CAM_FIX).forEach(function (k) { result[k] = CAM_FIX[k]; });
        try {
            var parsed = JSON.parse(localStorage.getItem(PICTURE_KEY) || 'null');
            if (parsed) Object.keys(result).forEach(function (k) {
                if (typeof parsed[k] === typeof result[k]) result[k] = parsed[k];
            });
        } catch (e) { /* ignore */ }
        return result;
    }

    function savePicture() {
        try { localStorage.setItem(PICTURE_KEY, JSON.stringify(picture)); } catch (e) { /* ignore */ }
    }

    function syncPicture(immediate) {
        clearTimeout(pictureTimer);
        var run = function () {
            var settings = {};
            Object.keys(picture).forEach(function (k) { settings[k] = picture[k]; });
            settings.enabled = picture.enabled && !pictureHeld;
            post(['mpv-set-picture', settings]);
        };
        if (immediate) run(); else pictureTimer = setTimeout(run, 60);
    }

    function load() {
        try {
            var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (parsed && Array.isArray(parsed.regions)) {
                return { enabled: parsed.enabled !== false, regions: parsed.regions };
            }
        } catch (e) { /* ignore */ }
        return { enabled: true, regions: [] };
    }

    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }

    function uid() {
        return Math.random().toString(36).slice(2, 10);
    }

    function onPlayer() {
        return /^#\/player/.test(location.hash);
    }

    function selected() {
        for (var i = 0; i < state.regions.length; i++) {
            if (state.regions[i].id === selectedId) return state.regions[i];
        }
        return null;
    }

    // ---------- shell communication ----------
    function post(args) {
        try {
            window.chrome.webview.postMessage(JSON.stringify({ id: 1, args: args }));
        } catch (e) { /* not inside the shell */ }
    }

    function activeRegions() {
        if (!onPlayer() || !state.enabled) return [];
        return state.regions.map(function (r) {
            return { x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind, strength: r.strength };
        });
    }

    function syncShell(immediate) {
        clearTimeout(sendTimer);
        var run = function () {
            var regions = activeRegions();
            var json = JSON.stringify(regions);
            if (json !== lastSentJson) {
                lastSentJson = json;
                post(['mpv-set-blur-regions', regions]);
            }
            applySubtitlePosition();
        };
        if (immediate) run(); else sendTimer = setTimeout(run, 200);
    }

    function subtitleRegion() {
        if (!state.enabled) return null;
        for (var i = 0; i < state.regions.length; i++) {
            if (state.regions[i].subs) return state.regions[i];
        }
        return null;
    }

    function applySubtitlePosition() {
        var region = onPlayer() && subtitleRegion();
        if (!region) return;
        // mpv sub-pos: 100 = bottom of the video. Subtitles sit just above that line
        // (by the default margin), so aim slightly below the region's bottom edge.
        var pos = Math.round((region.y + region.h) * 100 + 2);
        pos = Math.max(0, Math.min(100, pos));
        post(['mpv-set-prop', ['sub-pos', pos]]);
    }

    try {
        window.chrome.webview.addEventListener('message', function (event) {
            var data = event.data;
            if (typeof data === 'string') {
                if (data.indexOf('blur-video-info') === -1) return;
                try { data = JSON.parse(data); } catch (e) { return; }
            }
            if (data && Array.isArray(data.args) && data.args[0] === 'blur-video-info') {
                videoInfo = data.args[1];
                if (editing) renderOverlay();
            }
        });
    } catch (e) { /* not inside the shell */ }

    // ---------- geometry ----------
    // Where the video is drawn, in CSS pixels.
    function videoRect() {
        var vw = window.innerWidth, vh = window.innerHeight;
        var osd = videoInfo && videoInfo.osd;
        if (osd && osd.w > 0 && osd.h > 0) {
            var sx = vw / osd.w, sy = vh / osd.h;
            var w = (osd.w - (osd.ml || 0) - (osd.mr || 0)) * sx;
            var h = (osd.h - (osd.mt || 0) - (osd.mb || 0)) * sy;
            if (w > 10 && h > 10) {
                return { left: (osd.ml || 0) * sx, top: (osd.mt || 0) * sy, width: w, height: h };
            }
        }
        return { left: 0, top: 0, width: vw, height: vh };
    }

    function toNormalized(clientX, clientY) {
        var r = videoRect();
        return {
            x: clamp((clientX - r.left) / r.width, 0, 1),
            y: clamp((clientY - r.top) / r.height, 0, 1)
        };
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // ---------- styles ----------
    var css = '' +
        '#sbr-overlay{position:fixed;inset:0;z-index:2147483000;cursor:crosshair;background:rgba(0,0,0,0.15);user-select:none}' +
        '#sbr-overlay .sbr-video{position:absolute;outline:1px dashed rgba(255,255,255,0.35);pointer-events:none}' +
        '#sbr-overlay .sbr-region{position:absolute;box-sizing:border-box;border:2px solid #7b5bf5;background:rgba(123,91,245,0.18);cursor:move}' +
        '#sbr-overlay .sbr-region.sbr-sel{border-color:#fff;background:rgba(255,255,255,0.15)}' +
        '#sbr-overlay .sbr-region .sbr-label{position:absolute;left:4px;top:2px;font:600 11px/1.4 sans-serif;color:#fff;text-shadow:0 1px 2px #000;pointer-events:none;white-space:nowrap}' +
        '#sbr-overlay .sbr-handle{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #7b5bf5;border-radius:3px;box-sizing:border-box}' +
        '#sbr-overlay .sbr-h-nw{left:-7px;top:-7px;cursor:nwse-resize}#sbr-overlay .sbr-h-ne{right:-7px;top:-7px;cursor:nesw-resize}' +
        '#sbr-overlay .sbr-h-sw{left:-7px;bottom:-7px;cursor:nesw-resize}#sbr-overlay .sbr-h-se{right:-7px;bottom:-7px;cursor:nwse-resize}' +
        '#sbr-overlay .sbr-del{position:absolute;right:-10px;top:-30px;width:22px;height:22px;border-radius:11px;border:0;background:#e5484d;color:#fff;font:700 14px/22px sans-serif;cursor:pointer;padding:0}' +
        '#sbr-overlay .sbr-hint{position:absolute;left:50%;top:24px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:rgba(12,11,17,0.85);color:#fff;font:13px/1.4 sans-serif;pointer-events:none;text-align:center}' +
        '.sbr-panel{position:fixed;right:16px;bottom:96px;z-index:2147483001;width:300px;padding:14px;border-radius:12px;background:rgba(18,17,26,0.96);color:#fff;font:13px/1.4 sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.6)}' +
        '.sbr-panel h3{margin:0 0 10px;font-size:15px;font-weight:600}' +
        '.sbr-panel .sbr-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}' +
        '.sbr-panel label{display:flex;align-items:center;gap:8px;cursor:pointer}' +
        '.sbr-panel select,.sbr-panel input[type=range]{flex:1;min-width:0}' +
        '.sbr-panel select{background:#2a2838;color:#fff;border:1px solid #444;border-radius:6px;padding:4px}' +
        '.sbr-panel button.sbr-btn{flex:1;padding:8px;border:0;border-radius:8px;background:#7b5bf5;color:#fff;font:600 13px sans-serif;cursor:pointer}' +
        '.sbr-panel button.sbr-btn.sbr-sec{background:#2a2838}' +
        '.sbr-panel .sbr-muted{color:#aaa;font-size:12px}' +
        '.sbr-panel .sbr-list{max-height:120px;overflow:auto;margin:6px 0}' +
        '.sbr-panel .sbr-item{padding:5px 8px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between}' +
        '.sbr-panel .sbr-item.sbr-sel{background:#3b3550}' +
        '.sbr-panel fieldset{border:1px solid #333;border-radius:8px;padding:6px 10px;margin:8px 0}' +
        '.sbr-panel legend{padding:0 4px;color:#bbb;font-size:12px}' +
        '.sbr-panel{max-height:calc(100vh - 120px);overflow:auto;box-sizing:border-box}' +
        '.sbr-panel .sbr-slider{margin:8px 0}' +
        '.sbr-panel .sbr-slider input[type=range]{width:100%;accent-color:#7b5bf5}' +
        '.sbr-panel .sbr-slider-head{display:flex;justify-content:space-between;align-items:center}' +
        '.sbr-panel button.sbr-value{background:none;border:0;color:#bbb;font:12px monospace;cursor:pointer;padding:0 2px}' +
        '.sbr-panel button.sbr-value:hover{color:#fff;text-decoration:underline}' +
        '.sbr-button-active{background-color:rgba(123,91,245,0.35)!important}';

    function injectStyles() {
        if (document.getElementById('sbr-styles')) return;
        var style = document.createElement('style');
        style.id = 'sbr-styles';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    // ---------- control bar button ----------
    var ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="6" y="12" width="12" height="4" rx="1" fill="currentColor" opacity="0.45" stroke="none"/>' +
        '<path d="M7 9h2M11 9h2M15 9h2" stroke-dasharray="1 2"/></svg>';

    var PICTURE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0"/>' +
        '<circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>';

    function ensureButton() {
        makeButton('sbr-button', 'Blur regions', ICON, function () { setPanel(!panelOpen); });
        makeButton('sbr-picture-button', 'Picture settings', PICTURE_ICON, function () { setPicturePanel(!picturePanelOpen); });
    }

    function makeButton(id, title, icon, onClick) {
        if (!onPlayer()) return;
        var menu = document.querySelector('[class*="control-bar-buttons-menu-container"]');
        if (!menu || menu.querySelector('#' + id)) return;
        var sibling = null;
        var candidates = menu.querySelectorAll('[class*="control-bar-button"]');
        for (var i = 0; i < candidates.length; i++) {
            if (!/\bdisabled\b/.test(candidates[i].className)) { sibling = candidates[i]; break; }
        }
        sibling = sibling || candidates[0];
        var button = document.createElement('div');
        button.id = id;
        button.title = title;
        button.tabIndex = -1;
        button.className = sibling ? String(sibling.className).replace(/\bdisabled\b/g, '').trim() : '';
        if (!sibling) button.style.cssText = 'display:flex;align-items:center;justify-content:center;width:48px;height:48px;cursor:pointer;color:#fff';
        button.innerHTML = icon;
        var svg = button.firstChild;
        var siblingIcon = sibling && sibling.querySelector('svg');
        if (siblingIcon && siblingIcon.getAttribute('class')) {
            svg.setAttribute('class', siblingIcon.getAttribute('class'));
            svg.removeAttribute('width');
            svg.removeAttribute('height');
        }
        button.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        menu.appendChild(button);
        updateButton();
    }

    function updateButton() {
        var button = document.getElementById('sbr-button');
        if (button) button.classList.toggle('sbr-button-active', panelOpen || (state.enabled && state.regions.length > 0));
        var pictureButton = document.getElementById('sbr-picture-button');
        if (pictureButton) pictureButton.classList.toggle('sbr-button-active', picturePanelOpen || picture.enabled);
    }

    // ---------- panel ----------
    function setPanel(open) {
        panelOpen = open;
        if (!open) setEditing(false);
        if (open && picturePanelOpen) { picturePanelOpen = false; renderPicturePanel(); }
        renderPanel();
        updateButton();
    }

    function setPicturePanel(open) {
        picturePanelOpen = open;
        if (open && panelOpen) setPanel(false);
        renderPicturePanel();
        updateButton();
    }

    function formatValue(value, step) {
        return Number(value).toFixed(step < 0.01 ? 3 : 2);
    }

    function pictureChanged(immediate) {
        savePicture();
        syncPicture(immediate);
        updateButton();
    }

    function renderPicturePanel() {
        var old = document.getElementById('sbr-picture-panel');
        if (old) old.remove();
        if (!picturePanelOpen || !onPlayer()) return;

        var rows = PICTURE_SLIDERS.map(function (def) {
            var key = def[0], min = def[2], max = def[3], step = def[4], neutral = def[5];
            var valueLabel = el('button', {
                class: 'sbr-value', title: 'Click to reset to ' + neutral,
                text: formatValue(picture[key], step)
            });
            var slider = el('input', {
                type: 'range', min: String(min), max: String(max), step: String(step),
                value: String(picture[key]),
                oninput: function (e) {
                    picture[key] = Number(e.target.value);
                    valueLabel.textContent = formatValue(picture[key], step);
                    if (!picture.enabled) { picture.enabled = true; enabledBox.checked = true; }
                    pictureChanged(false);
                }
            });
            valueLabel.addEventListener('click', function () {
                picture[key] = neutral;
                slider.value = String(neutral);
                valueLabel.textContent = formatValue(neutral, step);
                pictureChanged(true);
            });
            return el('div', { class: 'sbr-slider' }, [
                el('div', { class: 'sbr-slider-head' }, [el('span', { text: def[1] }), valueLabel]),
                slider
            ]);
        });

        var enabledBox = el('input', {
            type: 'checkbox', checked: picture.enabled,
            onchange: function (e) { picture.enabled = e.target.checked; pictureChanged(true); }
        });

        function applyPreset(values) {
            Object.keys(values).forEach(function (k) { picture[k] = values[k]; });
            picture.enabled = true;
            pictureChanged(true);
            renderPicturePanel();
        }

        var neutralValues = {};
        PICTURE_SLIDERS.forEach(function (def) { neutralValues[def[0]] = def[5]; });

        var compare = el('button', { class: 'sbr-btn sbr-sec', text: 'Hold to compare' });
        var startCompare = function (e) {
            e.preventDefault();
            if (!picture.enabled || pictureHeld) return;
            pictureHeld = true; compare.textContent = 'Showing original'; syncPicture(true);
        };
        var endCompare = function () {
            if (!pictureHeld) return;
            pictureHeld = false; compare.textContent = 'Hold to compare'; syncPicture(true);
        };
        compare.addEventListener('mousedown', startCompare);
        compare.addEventListener('mouseup', endCompare);
        compare.addEventListener('mouseleave', endCompare);

        var panel = el('div', { id: 'sbr-picture-panel', class: 'sbr-panel' }, [
            el('h3', { text: 'Picture' }),
            el('div', { class: 'sbr-row' }, [
                el('label', null, [enabledBox, el('span', { text: 'Picture adjustments on' })])
            ]),
            el('div', { class: 'sbr-row' }, [
                el('button', { class: 'sbr-btn', text: 'Cam fix', onclick: function () { applyPreset(CAM_FIX); } }),
                el('button', { class: 'sbr-btn sbr-sec', text: 'Neutral', onclick: function () { applyPreset(neutralValues); } })
            ]),
            el('div', { class: 'sbr-sliders' }, rows),
            el('div', { class: 'sbr-row' }, [compare]),
            el('div', { class: 'sbr-muted', text: 'Changes apply instantly to every video. Click a number to reset that slider. While this is on, it replaces any shaders loaded from your mpv config.' })
        ]);
        ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown'].forEach(function (type) {
            panel.addEventListener(type, function (e) { e.stopPropagation(); });
        });
        document.body.appendChild(panel);
    }

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            if (k === 'text') node.textContent = attrs[k];
            else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
            else if (k === 'checked' || k === 'value' || k === 'selected') node[k] = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        (children || []).forEach(function (c) { if (c) node.appendChild(c); });
        return node;
    }

    function kindLabel(kind) {
        for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === kind) return KINDS[i][1];
        return kind;
    }

    function changed() {
        save();
        syncShell(false);
        updateButton();
        if (editing) renderOverlay();
    }

    function renderPanel() {
        var old = document.getElementById('sbr-panel');
        if (old) old.remove();
        if (!panelOpen || !onPlayer()) return;

        var sel = selected();
        var list = el('div', { class: 'sbr-list' }, state.regions.map(function (r, i) {
            return el('div', {
                class: 'sbr-item' + (r.id === selectedId ? ' sbr-sel' : ''),
                onclick: function () { selectedId = r.id; renderPanel(); if (editing) renderOverlay(); }
            }, [
                el('span', { text: 'Region ' + (i + 1) + (r.subs ? '  • subs' : '') }),
                el('span', { class: 'sbr-muted', text: kindLabel(r.kind) })
            ]);
        }));

        var editor = null;
        if (sel) {
            var strengthLabel = el('span', { class: 'sbr-muted', text: String(sel.strength) });
            editor = el('fieldset', null, [
                el('legend', { text: 'Selected region' }),
                el('div', { class: 'sbr-row' }, [
                    el('span', { text: 'Type' }),
                    el('select', {
                        onchange: function (e) { sel.kind = e.target.value; changed(); renderPanel(); }
                    }, KINDS.map(function (k) {
                        return el('option', { value: k[0], text: k[1], selected: k[0] === sel.kind });
                    }))
                ]),
                sel.kind === 'solid' ? null : el('div', { class: 'sbr-row' }, [
                    el('span', { text: 'Strength' }),
                    el('input', {
                        type: 'range', min: '1', max: '100', value: String(sel.strength),
                        oninput: function (e) {
                            sel.strength = Number(e.target.value);
                            strengthLabel.textContent = e.target.value;
                            changed();
                        }
                    }),
                    strengthLabel
                ]),
                el('div', { class: 'sbr-row' }, [
                    el('label', null, [
                        el('input', {
                            type: 'checkbox', checked: !!sel.subs,
                            onchange: function (e) {
                                state.regions.forEach(function (r) { r.subs = false; });
                                sel.subs = e.target.checked;
                                changed();
                                renderPanel();
                            }
                        }),
                        el('span', { text: 'Move Stremio subtitles here' })
                    ])
                ]),
                el('div', { class: 'sbr-row' }, [
                    el('button', {
                        class: 'sbr-btn sbr-sec', text: 'Delete region',
                        onclick: function () { removeRegion(sel.id); }
                    })
                ])
            ]);
        }

        var panel = el('div', { id: 'sbr-panel', class: 'sbr-panel' }, [
            el('h3', { text: 'Blur regions' }),
            el('div', { class: 'sbr-row' }, [
                el('label', null, [
                    el('input', {
                        type: 'checkbox', checked: state.enabled,
                        onchange: function (e) { state.enabled = e.target.checked; changed(); }
                    }),
                    el('span', { text: 'Blur enabled' })
                ])
            ]),
            state.regions.length ? list : el('div', { class: 'sbr-muted', text: 'No regions yet. Click "Draw regions", then drag over the video.' }),
            editor,
            el('div', { class: 'sbr-row' }, [
                el('button', {
                    class: 'sbr-btn', text: editing ? 'Done drawing' : 'Draw regions',
                    onclick: function () { setEditing(!editing); }
                }),
                state.regions.length ? el('button', {
                    class: 'sbr-btn sbr-sec', text: 'Clear all',
                    onclick: function () { state.regions = []; selectedId = null; changed(); renderPanel(); }
                }) : null
            ]),
            el('div', { class: 'sbr-muted', text: 'Regions are saved and apply to every video. Blur runs in the player, so it works in fullscreen too.' })
        ]);
        ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown'].forEach(function (type) {
            panel.addEventListener(type, function (e) { e.stopPropagation(); });
        });
        document.body.appendChild(panel);
    }

    function removeRegion(id) {
        state.regions = state.regions.filter(function (r) { return r.id !== id; });
        if (selectedId === id) selectedId = null;
        changed();
        renderPanel();
    }

    // ---------- drawing overlay ----------
    function setEditing(on) {
        editing = on && onPlayer();
        if (!editing) {
            var overlay = document.getElementById('sbr-overlay');
            if (overlay) overlay.remove();
        } else {
            renderOverlay();
        }
        if (panelOpen) renderPanel();
    }

    var drag = null; // { mode: 'new'|'move'|'nw'|'ne'|'sw'|'se', region, start, orig }

    function renderOverlay() {
        var overlay = document.getElementById('sbr-overlay');
        if (!editing) { if (overlay) overlay.remove(); return; }
        if (!overlay) {
            overlay = el('div', { id: 'sbr-overlay' });
            overlay.addEventListener('mousedown', onOverlayMouseDown);
            ['click', 'dblclick', 'mouseup', 'wheel', 'contextmenu'].forEach(function (type) {
                overlay.addEventListener(type, function (e) { e.stopPropagation(); if (type !== 'wheel') e.preventDefault(); });
            });
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = '';
        var vr = videoRect();
        overlay.appendChild(el('div', {
            class: 'sbr-video',
            style: 'left:' + vr.left + 'px;top:' + vr.top + 'px;width:' + vr.width + 'px;height:' + vr.height + 'px'
        }));
        overlay.appendChild(el('div', { class: 'sbr-hint', text: 'Drag to draw a region • drag a box to move it • corners resize • Esc when done' }));
        state.regions.forEach(function (r, i) {
            var box = el('div', {
                class: 'sbr-region' + (r.id === selectedId ? ' sbr-sel' : ''),
                style: 'left:' + (vr.left + r.x * vr.width) + 'px;top:' + (vr.top + r.y * vr.height) + 'px;width:' +
                    (r.w * vr.width) + 'px;height:' + (r.h * vr.height) + 'px'
            }, [el('span', { class: 'sbr-label', text: (i + 1) + ' · ' + kindLabel(r.kind) + (r.subs ? ' · subs' : '') })]);
            box.dataset.id = r.id;
            if (r.id === selectedId) {
                ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
                    var handle = el('div', { class: 'sbr-handle sbr-h-' + corner });
                    handle.dataset.corner = corner;
                    box.appendChild(handle);
                });
                var del = el('button', { class: 'sbr-del', text: '×', title: 'Delete region' });
                del.addEventListener('mousedown', function (e) { e.stopPropagation(); });
                del.addEventListener('click', function (e) { e.stopPropagation(); removeRegion(r.id); });
                box.appendChild(del);
            }
            overlay.appendChild(box);
        });
    }

    function onOverlayMouseDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        var p = toNormalized(e.clientX, e.clientY);
        var handle = e.target.closest('.sbr-handle');
        var box = e.target.closest('.sbr-region');
        var region = null;
        if (box) {
            selectedId = box.dataset.id;
            region = selected();
        }
        if (region) {
            drag = {
                mode: handle ? handle.dataset.corner : 'move',
                region: region,
                start: p,
                orig: { x: region.x, y: region.y, w: region.w, h: region.h }
            };
        } else {
            region = { id: uid(), x: p.x, y: p.y, w: 0, h: 0, kind: 'gaussian', strength: 60, subs: false };
            state.regions.push(region);
            selectedId = region.id;
            drag = { mode: 'new', region: region, start: p, orig: null };
        }
        renderOverlay();
        renderPanel();
        window.addEventListener('mousemove', onDragMove, true);
        window.addEventListener('mouseup', onDragEnd, true);
    }

    function onDragMove(e) {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        var p = toNormalized(e.clientX, e.clientY);
        var r = drag.region, o = drag.orig, s = drag.start;
        if (drag.mode === 'new') {
            r.x = Math.min(s.x, p.x); r.y = Math.min(s.y, p.y);
            r.w = Math.abs(p.x - s.x); r.h = Math.abs(p.y - s.y);
        } else if (drag.mode === 'move') {
            r.x = clamp(o.x + p.x - s.x, 0, 1 - o.w);
            r.y = clamp(o.y + p.y - s.y, 0, 1 - o.h);
        } else {
            var left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
            if (drag.mode.indexOf('w') !== -1) left = Math.min(p.x, right - MIN_SIZE);
            if (drag.mode.indexOf('e') !== -1) right = Math.max(p.x, left + MIN_SIZE);
            if (drag.mode.indexOf('n') !== -1) top = Math.min(p.y, bottom - MIN_SIZE);
            if (drag.mode.indexOf('s') !== -1) bottom = Math.max(p.y, top + MIN_SIZE);
            r.x = left; r.y = top; r.w = right - left; r.h = bottom - top;
        }
        renderOverlay();
    }

    function onDragEnd(e) {
        window.removeEventListener('mousemove', onDragMove, true);
        window.removeEventListener('mouseup', onDragEnd, true);
        if (!drag) return;
        e.stopPropagation();
        var r = drag.region;
        if (drag.mode === 'new' && (r.w < MIN_SIZE || r.h < MIN_SIZE)) {
            // A click on empty space just deselects.
            state.regions = state.regions.filter(function (x) { return x !== r; });
            selectedId = null;
        }
        drag = null;
        save();
        syncShell(true);
        updateButton();
        renderOverlay();
        renderPanel();
    }

    window.addEventListener('keydown', function (e) {
        if (!editing) return;
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopImmediatePropagation();
            setEditing(false);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
            e.preventDefault(); e.stopImmediatePropagation();
            removeRegion(selectedId);
        } else if (e.key === ' ' || e.key.indexOf('Arrow') === 0) {
            // keep normal player shortcuts working
        } else {
            e.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('resize', function () { if (editing) renderOverlay(); });

    // ---------- lifecycle ----------
    function onRouteChange() {
        if (!onPlayer()) {
            panelOpen = false;
            setEditing(false);
            renderPanel();
            picturePanelOpen = false;
            renderPicturePanel();
        } else {
            syncPicture(true);
        }
        syncShell(true);
    }

    function start() {
        injectStyles();
        var scheduled = false;
        new MutationObserver(function () {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(function () { scheduled = false; ensureButton(); });
        }).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('hashchange', onRouteChange);
        ensureButton();
        onRouteChange();
        // Stremio re-applies its own subtitle offset when tracks load; keep ours on top.
        setInterval(function () { if (onPlayer() && subtitleRegion()) applySubtitlePosition(); }, 3000);
        // Re-send after the player (re)creates the mpv state for a new stream.
        setInterval(function () { if (onPlayer()) { lastSentJson = null; syncShell(true); } }, 15000);
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
