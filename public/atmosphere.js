'use strict';
// Adapted directly from the owner's Somin WeatherAtmosphere.tsx canvas renderer.
// Source SHA-256: 818a9d3aae9fa8e219b11e12442efe1a48e138fe333588540187c49feb9b348e
// Drawing geometry, palettes, waves, palms, oaks, birds, rain and weather timing retained.
// Host adaptation: no React, no network, live reduced motion, hidden-page cancellation.
(() => {
    const canvas = document.getElementById('atmosphere'), group = document.getElementById('weather-switcher');
    if (!canvas || !group)
        return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx)
        return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'), contrast = matchMedia('(prefers-contrast: more)');
    const modeRef = { current: 'auto' };
    const intensity = 1;
    const PHASE_MS = { rain: 48000, sunrise: 36000, sunset: 36000 }, NEXT = { rain: 'sunrise', sunrise: 'sunset', sunset: 'rain' };
    try {
        const saved = localStorage.getItem('airodrom.atmosphere.v1');
        if (['auto', 'rain', 'sunrise', 'sunset', 'off'].includes(saved))
            modeRef.current = saved;
    }
    catch { }
    let staticFrame = false, hiddenAt = 0;
    let w = 0;
    let h = 0;
    let raf = 0;
    let drops = [];
    let bolts = [];
    let birds = [];
    let palms = [];
    let oaks = [];
    let flash = 0;
    let nextBoltAt = performance.now() + 2000;
    let phase = 'rain';
    let phaseStarted = performance.now();
    let visible = !document.hidden;
    let lastFrame = 0;
    let waveT = 0;
    let lastForced = 'auto';
    let dprCap = window.innerWidth < 768 ? 1 : 1.5;
    let dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const spawnDrop = (anywhere) => ({
        x: Math.random() * w,
        y: anywhere ? Math.random() * h : -Math.random() * 60,
        len: 7 + Math.random() * 14,
        speed: 6 + Math.random() * 11 * intensity,
        width: 0.55 + Math.random(),
        alpha: 0.22 + Math.random() * 0.4,
    });
    const spawnBird = () => {
        const x = w * (0.15 + Math.random() * 0.7);
        const y = h * (0.28 + Math.random() * 0.28);
        return {
            x,
            y,
            vx: (Math.random() - 0.5) * 1.4,
            vy: (Math.random() - 0.5) * 0.8,
            wing: Math.random() * Math.PI * 2,
            scale: 0.7 + Math.random() * 0.55,
            hue: Math.random() > 0.5 ? 155 : 340,
            targetX: x + (Math.random() - 0.5) * 120,
            targetY: y + (Math.random() - 0.5) * 60,
        };
    };
    const layoutScene = () => {
        palms = [
            { x: w * 0.06, scale: 1.15, lean: -0.08 },
            { x: w * 0.14, scale: 0.92, lean: 0.06 },
            { x: w * 0.22, scale: 1.05, lean: -0.04 },
            { x: w * 0.08, scale: 0.72, lean: 0.1 },
        ];
        oaks = [
            { x: w * 0.78, scale: 1.05 },
            { x: w * 0.88, scale: 1.25 },
            { x: w * 0.94, scale: 0.85 },
            { x: w * 0.72, scale: 0.7 },
        ];
        birds = Array.from({ length: Math.min(5, Math.max(3, Math.floor(w / 420))) }, () => spawnBird());
    };
    const resize = () => {
        dprCap = window.innerWidth < 768 ? 1 : 1.5;
        dpr = Math.min(window.devicePixelRatio || 1, dprCap);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const count = Math.min(90, Math.floor(((w * h) / 16000) * intensity));
        drops = Array.from({ length: Math.max(24, count) }, () => spawnDrop(true));
        layoutScene();
    };
    const makeBolt = () => {
        const startX = w * (0.15 + Math.random() * 0.7);
        const segments = [{ x: startX, y: 0 }];
        let x = startX;
        let y = 0;
        const targetY = h * (0.4 + Math.random() * 0.25);
        while (y < targetY) {
            x += (Math.random() - 0.5) * 44;
            y += 22 + Math.random() * 32;
            segments.push({ x, y: Math.min(y, targetY) });
        }
        const branches = [];
        const from = segments[Math.floor(segments.length * 0.4)];
        if (from) {
            const branch = [{ ...from }];
            let bx = from.x;
            let by = from.y;
            const dir = Math.random() > 0.5 ? 1 : -1;
            for (let i = 0; i < 4; i++) {
                bx += dir * (14 + Math.random() * 24);
                by += 16 + Math.random() * 22;
                branch.push({ x: bx, y: by });
            }
            branches.push(branch);
        }
        return {
            segments,
            branches,
            life: 1,
            maxLife: 0.32 + Math.random() * 0.2,
        };
    };
    const drawBoltPath = (points, alpha) => {
        if (points.length < 2)
            return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++)
            ctx.lineTo(points[i].x, points[i].y);
        ctx.strokeStyle = `rgba(200, 245, 255, ${alpha * 0.45})`;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    const skyColors = (p, t) => {
        if (p === 'rain') {
            return [
                'rgba(4, 14, 28, 0.72)',
                'rgba(8, 36, 52, 0.55)',
                'rgba(12, 40, 48, 0.35)',
            ];
        }
        if (p === 'sunrise') {
            const warm = 0.35 + t * 0.4;
            return [
                `rgba(${lerp(40, 255, warm)}, ${lerp(70, 170, warm)}, ${lerp(120, 100, warm)}, 0.75)`,
                `rgba(${lerp(255, 255, t)}, ${lerp(140, 200, t)}, ${lerp(90, 140, t)}, 0.65)`,
                `rgba(255, 220, 160, ${0.45 + t * 0.15})`,
            ];
        }
        return [
            `rgba(${lerp(255, 30, t)}, ${lerp(100, 25, t)}, ${lerp(70, 80, t)}, 0.72)`,
            `rgba(${lerp(255, 60, t)}, ${lerp(130, 40, t)}, ${lerp(90, 100, t)}, 0.6)`,
            `rgba(25, 15, 45, ${0.4 + t * 0.2})`,
        ];
    };
    const drawSky = (p, elapsed) => {
        const dur = PHASE_MS[p];
        const t = Math.min(1, elapsed / dur);
        const [c0, c1, c2] = skyColors(p, t);
        const g = ctx.createLinearGradient(0, 0, 0, h * 0.62);
        g.addColorStop(0, c0);
        g.addColorStop(0.5, c1);
        g.addColorStop(1, c2);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h * 0.62);
        if (p === 'sunrise' || p === 'sunset') {
            const sunX = p === 'sunrise' ? w * (0.2 + t * 0.25) : w * (0.7 - t * 0.22);
            const sunY = p === 'sunrise' ? h * (0.55 - t * 0.28) : h * (0.28 + t * 0.3);
            const r = Math.min(w, h) * 0.085;
            const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, r * 5);
            if (p === 'sunrise') {
                glow.addColorStop(0, 'rgba(255, 245, 200, 0.7)');
                glow.addColorStop(0.3, 'rgba(255, 170, 90, 0.28)');
                glow.addColorStop(1, 'rgba(255, 100, 40, 0)');
            }
            else {
                glow.addColorStop(0, 'rgba(255, 210, 140, 0.65)');
                glow.addColorStop(0.28, 'rgba(255, 80, 110, 0.25)');
                glow.addColorStop(1, 'rgba(60, 20, 100, 0)');
            }
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(sunX, sunY, r * 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle =
                p === 'sunrise' ? 'rgba(255, 248, 220, 0.95)' : 'rgba(255, 190, 130, 0.92)';
            ctx.beginPath();
            ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
            ctx.fill();
        }
    };
    const mountainTone = (p, depth) => {
        if (p === 'rain') {
            return `rgba(${20 + depth * 10}, ${35 + depth * 12}, ${48 + depth * 14}, ${0.55 + depth * 0.12})`;
        }
        if (p === 'sunrise') {
            return `rgba(${55 + depth * 30}, ${45 + depth * 25}, ${70 + depth * 20}, ${0.5 + depth * 0.15})`;
        }
        return `rgba(${40 + depth * 20}, ${25 + depth * 15}, ${55 + depth * 25}, ${0.55 + depth * 0.14})`;
    };
    const drawMountains = (p) => {
        const baseY = h * 0.52;
        const layers = [
            {
                depth: 0,
                peaks: [0, 0.12, 0.22, 0.35, 0.48, 0.6, 0.72, 0.85, 1],
                heights: [0.08, 0.22, 0.14, 0.28, 0.12, 0.24, 0.16, 0.2, 0.1],
            },
            {
                depth: 1,
                peaks: [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.88, 1],
                heights: [0.05, 0.16, 0.26, 0.14, 0.22, 0.12, 0.18, 0.08],
            },
            {
                depth: 2,
                peaks: [0, 0.15, 0.32, 0.5, 0.68, 0.82, 1],
                heights: [0.04, 0.14, 0.1, 0.2, 0.12, 0.16, 0.06],
            },
        ];
        for (const layer of layers) {
            ctx.beginPath();
            ctx.moveTo(0, h);
            ctx.lineTo(0, baseY);
            for (let i = 0; i < layer.peaks.length; i++) {
                const x = layer.peaks[i] * w;
                const y = baseY - layer.heights[i] * h;
                if (i === 0)
                    ctx.lineTo(x, y);
                else {
                    const px = layer.peaks[i - 1] * w;
                    const mid = (px + x) / 2;
                    ctx.quadraticCurveTo(mid, y - h * 0.02, x, y);
                }
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            ctx.fillStyle = mountainTone(p, layer.depth);
            ctx.fill();
            // snow caps on taller peaks
            if (layer.depth < 2) {
                ctx.fillStyle =
                    p === 'rain'
                        ? 'rgba(200, 220, 235, 0.35)'
                        : 'rgba(255, 250, 245, 0.55)';
                for (let i = 1; i < layer.peaks.length - 1; i++) {
                    if (layer.heights[i] < 0.18)
                        continue;
                    const x = layer.peaks[i] * w;
                    const y = baseY - layer.heights[i] * h;
                    ctx.beginPath();
                    ctx.moveTo(x - 18, y + 22);
                    ctx.lineTo(x, y);
                    ctx.lineTo(x + 16, y + 20);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        }
    };
    const drawOcean = (p, t) => {
        const top = h * 0.5;
        const ocean = ctx.createLinearGradient(0, top, 0, h);
        if (p === 'rain') {
            ocean.addColorStop(0, 'rgba(20, 60, 80, 0.75)');
            ocean.addColorStop(0.45, 'rgba(10, 40, 58, 0.85)');
            ocean.addColorStop(1, 'rgba(4, 20, 32, 0.92)');
        }
        else if (p === 'sunrise') {
            ocean.addColorStop(0, 'rgba(80, 160, 190, 0.7)');
            ocean.addColorStop(0.4, 'rgba(40, 110, 150, 0.82)');
            ocean.addColorStop(1, 'rgba(20, 50, 80, 0.9)');
        }
        else {
            ocean.addColorStop(0, 'rgba(90, 50, 120, 0.65)');
            ocean.addColorStop(0.4, 'rgba(30, 40, 90, 0.8)');
            ocean.addColorStop(1, 'rgba(10, 15, 40, 0.92)');
        }
        ctx.fillStyle = ocean;
        ctx.fillRect(0, top, w, h - top);
        // sun path reflection
        if (p === 'sunrise' || p === 'sunset') {
            const sunX = p === 'sunrise' ? w * (0.2 + t * 0.25) : w * (0.7 - t * 0.22);
            const refl = ctx.createLinearGradient(sunX, top, sunX, h * 0.85);
            refl.addColorStop(0, p === 'sunrise'
                ? 'rgba(255, 200, 120, 0.35)'
                : 'rgba(255, 120, 90, 0.28)');
            refl.addColorStop(1, 'rgba(255, 150, 80, 0)');
            ctx.fillStyle = refl;
            ctx.fillRect(sunX - 40, top, 80, h * 0.35);
        }
        // waves
        const waveAlpha = p === 'rain' ? 0.22 : 0.35;
        for (let row = 0; row < 5; row++) {
            const y0 = top + 18 + row * 22;
            ctx.beginPath();
            ctx.moveTo(0, y0);
            for (let x = 0; x <= w; x += 18) {
                const y = y0 +
                    Math.sin(x * 0.018 + waveT * (1.2 + row * 0.15) + row) * (3.5 + row * 0.8) +
                    Math.sin(x * 0.04 - waveT * 0.8) * 1.5;
                ctx.lineTo(x, y);
            }
            ctx.strokeStyle =
                p === 'rain'
                    ? `rgba(120, 200, 220, ${waveAlpha})`
                    : p === 'sunrise'
                        ? `rgba(255, 230, 190, ${waveAlpha})`
                        : `rgba(255, 180, 200, ${waveAlpha * 0.85})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
        // foam near shore (left coast)
        ctx.fillStyle =
            p === 'rain' ? 'rgba(180, 220, 230, 0.15)' : 'rgba(255, 250, 240, 0.22)';
        ctx.beginPath();
        ctx.moveTo(0, h * 0.72);
        for (let x = 0; x < w * 0.38; x += 12) {
            ctx.lineTo(x, h * 0.7 + Math.sin(x * 0.05 + waveT * 2) * 4 + Math.sin(waveT + x * 0.02) * 3);
        }
        ctx.lineTo(w * 0.35, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fill();
    };
    const drawPalm = (palm, p) => {
        const ground = h * 0.78;
        const s = palm.scale * Math.min(w, h) * 0.0011;
        const trunkH = 160 * s;
        ctx.save();
        ctx.translate(palm.x, ground);
        ctx.rotate(palm.lean);
        // trunk
        ctx.strokeStyle =
            p === 'rain' ? 'rgba(60, 45, 30, 0.85)' : 'rgba(90, 60, 35, 0.9)';
        ctx.lineWidth = 7 * s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(12 * s, -trunkH * 0.5, 4 * s, -trunkH);
        ctx.stroke();
        // fronds
        const crownY = -trunkH;
        const frondColor = p === 'rain'
            ? 'rgba(30, 90, 55, 0.8)'
            : p === 'sunrise'
                ? 'rgba(40, 130, 70, 0.88)'
                : 'rgba(25, 80, 50, 0.85)';
        for (let i = 0; i < 7; i++) {
            const ang = -Math.PI * 0.85 + (i / 6) * Math.PI * 0.95;
            const len = (70 + (i % 2) * 18) * s;
            ctx.strokeStyle = frondColor;
            ctx.lineWidth = 3 * s;
            ctx.beginPath();
            ctx.moveTo(4 * s, crownY);
            ctx.quadraticCurveTo(4 * s + Math.cos(ang) * len * 0.55, crownY + Math.sin(ang) * len * 0.4 + 10 * s, 4 * s + Math.cos(ang) * len, crownY + Math.sin(ang) * len * 0.75);
            ctx.stroke();
            // leaflet hints
            ctx.strokeStyle =
                p === 'rain' ? 'rgba(50, 120, 70, 0.45)' : 'rgba(70, 160, 90, 0.5)';
            ctx.lineWidth = 1.2 * s;
            for (let j = 1; j <= 3; j++) {
                const t = j / 3.5;
                const bx = 4 * s + Math.cos(ang) * len * t;
                const by = crownY + Math.sin(ang) * len * 0.75 * t;
                ctx.beginPath();
                ctx.moveTo(bx, by);
                ctx.lineTo(bx + Math.cos(ang + 0.9) * 12 * s, by + 8 * s);
                ctx.stroke();
            }
        }
        ctx.restore();
    };
    const drawOak = (oak, p) => {
        const ground = h * 0.76;
        const s = oak.scale * Math.min(w, h) * 0.00115;
        ctx.save();
        ctx.translate(oak.x, ground);
        // trunk
        ctx.fillStyle =
            p === 'rain' ? 'rgba(45, 32, 22, 0.88)' : 'rgba(70, 48, 30, 0.92)';
        ctx.beginPath();
        ctx.moveTo(-10 * s, 0);
        ctx.quadraticCurveTo(-6 * s, -90 * s, -4 * s, -130 * s);
        ctx.lineTo(6 * s, -128 * s);
        ctx.quadraticCurveTo(8 * s, -90 * s, 12 * s, 0);
        ctx.closePath();
        ctx.fill();
        // canopy lobes
        const canopy = p === 'rain'
            ? 'rgba(25, 70, 40, 0.82)'
            : p === 'sunrise'
                ? 'rgba(45, 110, 55, 0.88)'
                : 'rgba(30, 75, 45, 0.85)';
        const lobes = [
            { x: -35, y: -145, r: 42 },
            { x: 10, y: -160, r: 48 },
            { x: 40, y: -140, r: 38 },
            { x: -5, y: -120, r: 36 },
            { x: 25, y: -115, r: 32 },
        ];
        ctx.fillStyle = canopy;
        for (const lobe of lobes) {
            ctx.beginPath();
            ctx.ellipse(lobe.x * s, lobe.y * s, lobe.r * s, lobe.r * 0.85 * s, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        // highlight
        ctx.fillStyle =
            p === 'sunrise' ? 'rgba(120, 180, 90, 0.2)' : 'rgba(80, 140, 90, 0.12)';
        ctx.beginPath();
        ctx.ellipse(5 * s, -155 * s, 28 * s, 22 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };
    const drawColibri = (b, now) => {
        b.wing += 0.55;
        const dx = b.targetX - b.x;
        const dy = b.targetY - b.y;
        b.vx += dx * 0.0025;
        b.vy += dy * 0.0025;
        b.vx *= 0.96;
        b.vy *= 0.96;
        b.x += b.vx;
        b.y += b.vy + Math.sin(now * 0.006 + b.hue) * 0.35;
        if (Math.hypot(dx, dy) < 18 || Math.random() < 0.008) {
            b.targetX = Math.max(40, Math.min(w - 40, b.x + (Math.random() - 0.5) * 160));
            b.targetY = Math.max(h * 0.22, Math.min(h * 0.55, b.y + (Math.random() - 0.5) * 80));
        }
        const facing = b.vx >= 0 ? 1 : -1;
        const s = b.scale * 1.15;
        const flap = Math.sin(b.wing) * 0.85;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.scale(facing * s, s);
        // wings (blurred flutter)
        ctx.fillStyle = `hsla(${b.hue}, 70%, 55%, 0.45)`;
        ctx.beginPath();
        ctx.ellipse(-2, -2, 10, 3.5, -0.6 + flap, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-2, 2, 9, 3, 0.55 - flap, 0, Math.PI * 2);
        ctx.fill();
        // body
        const body = ctx.createLinearGradient(-6, 0, 10, 0);
        body.addColorStop(0, `hsla(${b.hue}, 75%, 42%, 0.95)`);
        body.addColorStop(1, `hsla(${(b.hue + 40) % 360}, 80%, 55%, 0.95)`);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(2, 0, 7, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        // head
        ctx.fillStyle = `hsla(${(b.hue + 20) % 360}, 85%, 50%, 0.95)`;
        ctx.beginPath();
        ctx.arc(8, -1, 2.6, 0, Math.PI * 2);
        ctx.fill();
        // long beak
        ctx.strokeStyle = 'rgba(40, 30, 20, 0.9)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(10, -1);
        ctx.lineTo(18, 0.5);
        ctx.stroke();
        // tail
        ctx.fillStyle = `hsla(${b.hue}, 65%, 40%, 0.85)`;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-14, -4);
        ctx.lineTo(-12, 0);
        ctx.lineTo(-14, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };
    const rainStrength = (p, elapsed) => {
        const dur = PHASE_MS[p];
        const edge = 4500;
        if (p === 'rain') {
            if (elapsed < edge)
                return elapsed / edge;
            if (elapsed > dur - edge)
                return (dur - elapsed) / edge;
            return 1;
        }
        if (elapsed < 3500)
            return 1 - elapsed / 3500;
        return 0;
    };
    const frame = (now) => {
        raf = 0;
        if (!visible || modeRef.current === 'off' || contrast.matches)
            return;
        if (!staticFrame && now - lastFrame < 28) {
            if (!staticFrame)
                raf = requestAnimationFrame(frame);
            return;
        }
        lastFrame = now;
        waveT += 0.045;
        const forced = staticFrame && modeRef.current === 'auto' ? phase : modeRef.current;
        if (forced !== 'auto') {
            if (forced !== lastForced || phase !== forced) {
                phase = forced;
                phaseStarted = now;
                bolts = [];
                flash = 0;
                if (phase === 'rain')
                    nextBoltAt = now + 400;
            }
            lastForced = forced;
        }
        else if (lastForced !== 'auto') {
            // Re-enter cycle clearly from rain when AUTO is selected
            phase = 'rain';
            phaseStarted = now;
            bolts = [];
            flash = 0;
            nextBoltAt = now + 800;
            lastForced = 'auto';
        }
        else {
            const elapsedAuto = now - phaseStarted;
            if (elapsedAuto >= PHASE_MS[phase]) {
                phase = NEXT[phase];
                phaseStarted = now;
                bolts = [];
                flash = 0;
                if (phase === 'rain')
                    nextBoltAt = now + 1500;
            }
        }
        let elapsed = now - phaseStarted;
        // Manual lock: hold peak look (full rain / mid sun) — no fade-in dead zone
        if (forced !== 'auto') {
            const dur = PHASE_MS[phase];
            elapsed = phase === 'rain' ? dur * 0.5 : dur * 0.42;
        }
        const t = Math.min(1, elapsed / PHASE_MS[phase]);
        ctx.clearRect(0, 0, w, h);
        drawSky(phase, elapsed);
        drawMountains(phase);
        drawOcean(phase, t);
        // shore / grass strip under trees
        const shore = ctx.createLinearGradient(0, h * 0.7, 0, h);
        shore.addColorStop(0, phase === 'rain' ? 'rgba(35, 55, 40, 0.55)' : 'rgba(50, 90, 45, 0.5)');
        shore.addColorStop(1, 'rgba(15, 25, 20, 0.35)');
        ctx.fillStyle = shore;
        ctx.fillRect(0, h * 0.7, w, h * 0.3);
        for (const oak of oaks)
            drawOak(oak, phase);
        for (const palm of palms)
            drawPalm(palm, phase);
        // colibrí more active in clear weather
        const birdAlpha = phase === 'rain' ? 0.55 : 1;
        ctx.globalAlpha = birdAlpha;
        for (const bird of birds)
            drawColibri(bird, now);
        ctx.globalAlpha = 1;
        const rainAmt = rainStrength(phase, elapsed);
        if (rainAmt > 0.02) {
            const active = Math.floor(drops.length * Math.min(1, rainAmt * 1.1));
            for (let i = 0; i < active; i++) {
                const d = drops[i];
                d.y += d.speed;
                d.x += 0.3 + d.speed * 0.035;
                if (d.y > h + 20 || d.x > w + 20) {
                    drops[i] = spawnDrop(false);
                    continue;
                }
                ctx.globalAlpha = d.alpha * rainAmt;
                ctx.strokeStyle = 'rgba(160, 220, 230, 0.9)';
                ctx.lineWidth = d.width;
                ctx.beginPath();
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x - 1.4, d.y + d.len);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            if (!staticFrame && phase === 'rain' && rainAmt > 0.55 && now >= nextBoltAt) {
                bolts.push(makeBolt());
                if (Math.random() > 0.55)
                    bolts.push(makeBolt());
                flash = 0.5 + Math.random() * 0.3;
                nextBoltAt = now + 2800 + Math.random() * 5000;
            }
        }
        bolts = bolts.filter((b) => {
            b.life -= 0.02 / b.maxLife;
            if (b.life <= 0)
                return false;
            const a = Math.max(0, Math.min(1, b.life));
            drawBoltPath(b.segments, a);
            for (const br of b.branches)
                drawBoltPath(br, a * 0.7);
            return true;
        });
        if (flash > 0.01) {
            ctx.fillStyle = `rgba(160, 220, 255, ${flash * 0.18})`;
            ctx.fillRect(0, 0, w, h);
            flash *= 0.86;
        }
        if (!staticFrame)
            raf = requestAnimationFrame(frame);
    };
    function sync() {
        cancelAnimationFrame(raf);
        raf = 0;
        visible = !document.hidden;
        canvas.hidden = modeRef.current === 'off' || contrast.matches;
        for (const b of group.querySelectorAll('[data-weather]'))
            b.setAttribute('aria-pressed', String(b.dataset.weather === modeRef.current));
        const note = group.querySelector('small');
        if (note)
            note.textContent = reduced.matches ? 'Visual presets · Static: Reduce Motion is enabled' : 'Visual presets · Auto cycles scenes · No live weather';
        if (!visible || canvas.hidden)
            return;
        staticFrame = reduced.matches;
        lastFrame = -Infinity;
        if (staticFrame) {
            bolts = [];
            flash = 0;
            frame(performance.now());
        }
        else
            raf = requestAnimationFrame(frame);
    }
    for (const b of group.querySelectorAll('[data-weather]'))
        b.addEventListener('click', () => {
            modeRef.current = b.dataset.weather;
            try {
                localStorage.setItem('airodrom.atmosphere.v1', modeRef.current);
            }
            catch { }
            sync();
        });
    document.addEventListener('visibilitychange', () => { const now = performance.now(); if (document.hidden)
        hiddenAt = now;
    else if (hiddenAt) {
        phaseStarted += now - hiddenAt;
        hiddenAt = 0;
    } sync(); });
    reduced.addEventListener('change', sync);
    contrast.addEventListener('change', sync);
    window.addEventListener('resize', () => { resize(); sync(); });
    window.addEventListener('pagehide', () => cancelAnimationFrame(raf));
    resize();
    sync();
})();
