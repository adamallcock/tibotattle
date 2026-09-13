// Decorative only: the caller owns measured capacity and forecast standing.
// All drawing is local and bounded; no percentage is depleted by this renderer.
export function drawAllowanceTank(
  canvas,
  { remaining, pace, time = 0, tilt: slosh = 0, colors, width, dpr = 1 },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const height = 418;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const state = { pace: pace === null ? 0 : Math.max(0.1, Math.min(5, pace)) };
  const vessel = { x: width / 2, y: 12, w: Math.min(228, width - 42), h: 220 };
  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }
  function alpha(color, a) {
    return color.replace("rgb(", "rgba(").replace(")", "," + a + ")");
  }
  function waveY(px, p, offset) {
    const full = remaining / 100;
    const base = p.y + p.h * (1 - full);
    const edge = Math.min(1, full * 12, (1 - full) * 12);
    return (
      base +
      (Math.sin((px / p.w) * 7 + time * 1.1 + offset) * 3 +
        Math.sin((px / p.w) * 13 - time * 0.85 + offset) * 1.6 +
        slosh * (px / p.w - 0.5)) *
        edge
    );
  }
  function fillWave(p, offset, fill) {
    ctx.beginPath();
    for (let px = 0; px <= p.w; px += 3) {
      const y = waveY(px, p, offset);
      if (px === 0) ctx.moveTo(p.x - p.w / 2, y);
      else ctx.lineTo(p.x - p.w / 2 + px, y);
    }
    ctx.lineTo(p.x + p.w / 2, p.y + p.h + 5);
    ctx.lineTo(p.x - p.w / 2, p.y + p.h + 5);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    {
      const p = vessel,
        left = p.x - p.w / 2,
        right = p.x + p.w / 2,
        bottom = p.y + p.h;
      const { fluid: fuel, glow, deep } = colors;
      {
        ctx.save();
        const halo = ctx.createRadialGradient(
          p.x,
          p.y + p.h * 0.7,
          15,
          p.x,
          p.y + p.h * 0.7,
          p.w * 0.85,
        );
        halo.addColorStop(0, alpha(fuel, state.pace >= 2 ? 0.24 : 0.09));
        halo.addColorStop(1, alpha(fuel, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(left - 40, p.y - 30, p.w + 80, p.h + 100);
        ctx.restore();
      }
      // Cast shadow grounds each vessel on a shallow machinery shelf.
      ctx.save();
      ctx.fillStyle = alpha(colors.shadow, 0.16);
      ctx.filter = "blur(10px)";
      ctx.beginPath();
      ctx.ellipse(p.x, bottom + 26, p.w * 0.57, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const shell = ctx.createLinearGradient(left, 0, right, 0);
      shell.addColorStop(0, alpha(colors.edge, 0.33));
      shell.addColorStop(0.12, alpha(colors.bright, 0.42));
      shell.addColorStop(0.42, alpha(colors.panel, 0.15));
      shell.addColorStop(0.8, alpha(colors.panel, 0.05));
      shell.addColorStop(1, alpha(colors.edge, 0.5));
      rounded(left, p.y, p.w, p.h, [22, 22, 35, 35]);
      ctx.fillStyle = shell;
      ctx.fill();
      ctx.save();
      ctx.clip();
      // Back surface, body depth and luminous front surface use independent phases.
      fillWave(p, 1.8, alpha(fuel, 0.28));
      const liquid = ctx.createLinearGradient(0, p.y, 0, bottom);
      liquid.addColorStop(0, alpha(glow, 0.8));
      liquid.addColorStop(0.45, alpha(fuel, 0.82));
      liquid.addColorStop(1, deep);
      fillWave(p, 0, liquid);
      ctx.save();
      ctx.beginPath();
      for (let px = 0; px <= p.w; px += 2) {
        const y = waveY(px, p, 0);
        if (px === 0) ctx.moveTo(left, y);
        else ctx.lineTo(left + px, y);
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = alpha(glow, 0.9);
      ctx.shadowColor = glow;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.restore();
      // Suspended highlights circulate inside the liquid, never above its surface.
      for (let b = 0; b < 14; b++) {
        const bx = left + 12 + ((b * 47) % (p.w - 24)),
          travel = (time * (5 + (b % 4) * 2) + b * 21) % p.h,
          by = bottom - travel;
        if (by > waveY(bx - left, p, 0) + 8) {
          ctx.beginPath();
          ctx.arc(
            bx + Math.sin(time + b) * 3,
            by,
            1 + (b % 3) * 0.65,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = alpha(glow, 0.13 + (b % 4) * 0.05);
          ctx.fill();
        }
      }
      const depth = ctx.createLinearGradient(left, 0, right, 0);
      depth.addColorStop(0, alpha(colors.shadow, 0.4));
      depth.addColorStop(0.12, "transparent");
      depth.addColorStop(0.76, "transparent");
      depth.addColorStop(1, alpha(colors.shadow, 0.35));
      ctx.fillStyle = depth;
      ctx.fillRect(left, p.y, p.w, p.h);
      // Glass reflections remain independent of the fluid.
      const reflection = ctx.createLinearGradient(left, 0, left + p.w * 0.3, 0);
      reflection.addColorStop(0, "transparent");
      reflection.addColorStop(0.35, alpha(colors.bright, 0.4));
      reflection.addColorStop(1, "transparent");
      ctx.fillStyle = reflection;
      ctx.fillRect(left + 5, p.y + 5, p.w * 0.23, p.h - 10);
      ctx.restore();
      rounded(left, p.y, p.w, p.h, [22, 22, 35, 35]);
      ctx.strokeStyle = alpha(colors.edge, 0.65);
      ctx.lineWidth = 1;
      ctx.stroke();
      // Calibrated marks, on the glass rather than the liquid layer.
      for (let tick = 0; tick <= 10; tick++) {
        const y = p.y + 8 + ((p.h - 16) * tick) / 10;
        ctx.beginPath();
        ctx.moveTo(right - 8, y);
        ctx.lineTo(right - (tick % 5 === 0 ? 26 : 16), y);
        ctx.strokeStyle = alpha(colors.ink, tick % 5 === 0 ? 0.45 : 0.2);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const metal = ctx.createLinearGradient(0, p.y - 10, 0, p.y + 12);
      metal.addColorStop(0, colors.bright);
      metal.addColorStop(0.22, colors.metal);
      metal.addColorStop(0.5, colors.edge);
      metal.addColorStop(0.62, colors.bright);
      metal.addColorStop(1, colors.metal);
      rounded(left - 5, p.y - 7, p.w + 10, 15, 5);
      ctx.fillStyle = metal;
      ctx.fill();
      rounded(left - 5, bottom - 8, p.w + 10, 17, 6);
      ctx.fillStyle = metal;
      ctx.fill();
      // Drain valve and drops: rhythm belongs only to the forecasted pool.
      ctx.fillStyle = colors.metal;
      rounded(p.x - 13, bottom + 7, 26, 13, 4);
      ctx.fill();
      ctx.fillStyle = colors.edge;
      rounded(p.x - 6, bottom + 18, 12, 8, 3);
      ctx.fill();
      // Fixed gravity, changing discharge: frequency and width encode pace.
      const flowing = pace !== null && remaining > 0.2,
        rate = state.pace,
        excess = Math.max(0, rate - 1),
        basinY = bottom + 75,
        half = 56;
      if (flowing) {
        ctx.save();
        ctx.fillStyle = fuel;
        ctx.strokeStyle = fuel;
        ctx.shadowColor = glow;
        ctx.shadowBlur = 8;
        if (rate > 1.15) {
          const jet = 2.5 + Math.min(5, excess) * 2.5;
          ctx.beginPath();
          for (let y = bottom + 26; y <= basinY; y += 2) {
            const spread = jet * (0.65 + (0.35 * (y - bottom - 26)) / 49),
              wobble = Math.sin(y * 0.27 - time * 13) * Math.min(1.8, excess);
            if (y === bottom + 26) ctx.moveTo(p.x - spread + wobble, y);
            else ctx.lineTo(p.x - spread + wobble, y);
          }
          for (let y = basinY; y >= bottom + 26; y -= 2)
            ctx.lineTo(
              p.x +
                jet * (0.65 + (0.35 * (y - bottom - 26)) / 49) +
                Math.sin(y * 0.3 - time * 15) * 1.2,
              y,
            );
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = alpha(glow, 0.8);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x - 1, bottom + 26);
          ctx.lineTo(p.x + Math.sin(time * 9), basinY);
          ctx.stroke();
        } else {
          const frequency = rate * 3.5,
            flight = 0.48;
          for (let n = 0; n < 3; n++) {
            const age = (time + n / frequency) % (3 / frequency);
            if (age > flight) continue;
            const q = age / flight;
            ctx.beginPath();
            ctx.ellipse(
              p.x,
              bottom + 27 + q * q * 47,
              2.7,
              3.5 + q * 3,
              0,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          }
        }
        // Short ballistic sprays become denser as excess flow grows.
        const sprays = rate > 1.15 ? Math.min(24, Math.ceil(rate * 5)) : 3;
        for (let n = 0; n < sprays; n++) {
          const q = (time * (1.4 + (n % 3) * 0.12) + n / sprays) % 1,
            sign = n % 2 ? 1 : -1;
          ctx.globalAlpha = (1 - q) * 0.7;
          ctx.beginPath();
          ctx.arc(
            p.x + sign * q * (12 + (n % 5) * 5 + excess * 5),
            basinY - Math.sin(q * Math.PI) * (5 + (n % 4) * 3 + excess * 3),
            1 + (n % 3) * 0.55,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.restore();
      }
      // Perspective basin with a moving surface, impact crater and travelling capillary waves.
      ctx.save();
      const basinDepth = 26,
        surfaceY = basinY + (flowing ? Math.max(0, 1 - rate) * 17 : 19),
        energy = flowing ? Math.min(1.8, rate * 0.45) : 0;
      const surface = (x, phase = 0) =>
        surfaceY +
        energy *
          (Math.sin(Math.abs(x) * 0.21 - time * 7 + phase) * 1.7 +
            Math.sin(x * 0.12 + time * 3.8) * 1.1) +
        Math.exp((-x * x) / 95) * energy * 3;
      const body = ctx.createLinearGradient(
        0,
        basinY - 6,
        0,
        basinY + basinDepth,
      );
      body.addColorStop(0, alpha(colors.bright, 0.65));
      body.addColorStop(0.3, alpha(colors.metal, 0.6));
      body.addColorStop(1, alpha(colors.edge, 0.8));
      rounded(
        p.x - half - 5,
        basinY - 5,
        half * 2 + 10,
        basinDepth + 7,
        [8, 8, 19, 19],
      );
      ctx.fillStyle = body;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(p.x, basinY - 3, half + 4, 7, 0, 0, Math.PI * 2);
      ctx.fillStyle = alpha(colors.shadow, 0.22);
      ctx.fill();
      ctx.save();
      rounded(p.x - half, basinY - 7, half * 2, basinDepth + 7, [5, 5, 16, 16]);
      ctx.clip();
      if (flowing) {
        const water = ctx.createLinearGradient(
          0,
          surfaceY - 4,
          0,
          basinY + basinDepth,
        );
        water.addColorStop(0, glow);
        water.addColorStop(0.23, fuel);
        water.addColorStop(1, deep);
        ctx.beginPath();
        for (let x = -half; x <= half; x += 2) {
          if (x === -half) ctx.moveTo(p.x + x, surface(x));
          else ctx.lineTo(p.x + x, surface(x));
        }
        ctx.lineTo(p.x + half, basinY + basinDepth);
        ctx.lineTo(p.x - half, basinY + basinDepth);
        ctx.closePath();
        ctx.fillStyle = water;
        ctx.fill();
        // Caustic filaments drift through the shallow bowl.
        for (let j = 0; j < 5; j++) {
          ctx.beginPath();
          for (let x = -half; x <= half; x += 3) {
            const y =
              surfaceY + 5 + j * 3 + Math.sin(x * 0.12 - time * 3 + j) * 1.7;
            if (x === -half) ctx.moveTo(p.x + x, y);
            else ctx.lineTo(p.x + x, y);
          }
          ctx.strokeStyle = alpha(glow, 0.13);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        // Concentric rings travel away from the incoming jet.
        for (let j = 0; j < 4; j++) {
          const q = (time * (0.65 + Math.min(rate, 2) * 0.2) + j / 4) % 1;
          ctx.beginPath();
          ctx.ellipse(
            p.x,
            surfaceY + 2,
            3 + q * (half + 4),
            1 + q * 5,
            0,
            0,
            Math.PI * 2,
          );
          ctx.strokeStyle = alpha(glow, (1 - q) * 0.65);
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }
        // Fine bubbles circulate outwards from impact, fading near the lip.
        for (let j = 0; j < 18; j++) {
          const q = (time * (0.22 + (j % 3) * 0.05) + j / 18) % 1,
            sign = j % 2 ? 1 : -1,
            x = sign * q * (half - 3),
            y = surface(x) + 3 + (j % 4) * 2;
          ctx.beginPath();
          ctx.ellipse(
            p.x + x,
            y,
            0.7 + (j % 3) * 0.45,
            0.55,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = alpha(glow, Math.sin(q * Math.PI) * 0.65);
          ctx.fill();
        }
        ctx.beginPath();
        for (let x = -half; x <= half; x += 2) {
          if (x === -half) ctx.moveTo(p.x + x, surface(x));
          else ctx.lineTo(p.x + x, surface(x));
        }
        ctx.strokeStyle = alpha(glow, 0.85);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
      // Front glass edge and a reflection give the moving liquid depth.
      ctx.beginPath();
      ctx.moveTo(p.x - half - 2, basinY + 4);
      ctx.quadraticCurveTo(
        p.x - half,
        basinY + 29,
        p.x - half + 19,
        basinY + 29,
      );
      ctx.lineTo(p.x + half - 19, basinY + 29);
      ctx.quadraticCurveTo(p.x + half, basinY + 29, p.x + half + 2, basinY + 4);
      ctx.strokeStyle = alpha(colors.bright, 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = colors.edge;
      rounded(p.x - 4, basinY + 29, 8, 7, 2);
      ctx.fill();
      if (flowing) {
        // Sustainable centre outlet retains the same slender discharge at every over-pace setting.
        for (let j = 0; j < 3; j++) {
          const q = (time * 2 + j / 3) % 1;
          ctx.beginPath();
          ctx.ellipse(
            p.x,
            basinY + 38 + q * q * 23,
            1.7,
            2.5 + q * 2,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = alpha(fuel, 1 - q * 0.7);
          ctx.fill();
        }
        // Crown lobes rise and collapse around the jet, rather than random screen-space confetti.
        for (const sign of [-1, 1]) {
          const pulse =
              (time * (1.3 + rate * 0.12) + (sign === 1 ? 0.45 : 0)) % 1,
            lift = Math.sin(pulse * Math.PI) * (5 + energy * 8),
            x = p.x + sign * (7 + pulse * 9);
          ctx.beginPath();
          ctx.moveTo(p.x + sign * 4, surfaceY + 1);
          ctx.quadraticCurveTo(x, surfaceY - lift, x + sign * 7, surfaceY + 2);
          ctx.strokeStyle = alpha(glow, 0.55);
          ctx.lineWidth = 2.4;
          ctx.stroke();
        }
      }
      // Overflow ribbons have travelling bulges and highlights; gravity accelerates and narrows them.
      if (flowing && excess > 0) {
        const spill = Math.min(10, excess * 3.3),
          reach = 14 + Math.min(3, excess) * 5,
          fall = 65;
        for (const sign of [-1, 1]) {
          const phase = sign === 1 ? 1.7 : 0;
          const point = (q) => ({
            x:
              p.x +
              sign * (half - 3 + reach * (1 - Math.exp(-q * 5))) +
              Math.sin(q * 10 - time * 5 + phase) * q * 1.4,
            y: basinY + q * q * fall - 2 * Math.sin(q * Math.PI),
          });
          const radius = (q) =>
            Math.max(
              0.7,
              spill *
                (1 - 0.64 * q) *
                (1 + 0.2 * Math.sin(q * 24 - time * 12 + phase)),
            );
          // A translucent wet edge sits around the opaque body of the falling ribbon.
          for (const outer of [true, false]) {
            ctx.beginPath();
            for (let k = 0; k <= 40; k++) {
              const q = k / 40,
                a = point(q),
                r = radius(q) + (outer ? 1.4 : 0);
              if (k === 0) ctx.moveTo(a.x - r, a.y);
              else ctx.lineTo(a.x - r, a.y);
            }
            for (let k = 40; k >= 0; k--) {
              const q = k / 40,
                a = point(q);
              ctx.lineTo(a.x + radius(q) + (outer ? 1.4 : 0), a.y);
            }
            ctx.closePath();
            ctx.fillStyle = outer ? alpha(glow, 0.24) : fuel;
            ctx.fill();
          }
          // Specular streaks travel down the same curve, visibly carrying the flow.
          for (let j = 0; j < 5; j++) {
            const q = (time * 0.95 + j / 5) % 1;
            ctx.beginPath();
            for (let k = 0; k < 7; k++) {
              const t = Math.min(1, q + k * 0.011),
                a = point(t);
              if (k === 0) ctx.moveTo(a.x - sign * radius(t) * 0.3, a.y);
              else ctx.lineTo(a.x - sign * radius(t) * 0.3, a.y);
            }
            ctx.strokeStyle = alpha(glow, 0.75 * (1 - q * 0.5));
            ctx.lineWidth = 1.4;
            ctx.stroke();
          }
          const end = point(1),
            floor = basinY + 83;
          // Neck breakup: droplets retain downward momentum and stretch before landing.
          for (let j = 0; j < 5; j++) {
            const q = (time * 2.3 + j / 5 + phase) % 1;
            ctx.beginPath();
            ctx.ellipse(
              end.x + Math.sin(j * 4 + phase) * q * 2,
              end.y + q * q * 18,
              Math.max(1.2, spill * 0.25) * (1 - q * 0.25),
              2.5 + q * 2,
              0,
              0,
              Math.PI * 2,
            );
            ctx.fillStyle = alpha(fuel, 1 - q * 0.45);
            ctx.fill();
          }
          const puddle = 16 + Math.min(3, excess) * 3;
          ctx.beginPath();
          ctx.ellipse(end.x, floor, puddle, 4, 0, 0, Math.PI * 2);
          ctx.fillStyle = alpha(fuel, 0.22);
          ctx.fill();
          for (let j = 0; j < 3; j++) {
            const q = (time * 1.2 + j / 3 + phase) % 1;
            ctx.beginPath();
            ctx.ellipse(
              end.x,
              floor,
              2 + q * puddle,
              1 + q * 3,
              0,
              0,
              Math.PI * 2,
            );
            ctx.strokeStyle = alpha(fuel, (1 - q) * 0.65);
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          // Tiny ballistic landing splashes connect the stream to its contact patch.
          for (let j = 0; j < 8; j++) {
            const q = (time * (1.2 + (j % 3) * 0.2) + j / 8 + phase) % 1,
              side = j % 2 ? 1 : -1;
            ctx.beginPath();
            ctx.arc(
              end.x + side * q * (7 + (j % 4) * 3),
              floor - 4 * q * (1 - q) * (5 + (j % 3) * 3),
              0.8 + (j % 3) * 0.3,
              0,
              Math.PI * 2,
            );
            ctx.fillStyle = alpha(glow, (1 - q) * 0.8);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }
  }

  draw();
  return true;
}
