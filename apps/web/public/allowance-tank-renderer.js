// Decorative only: the caller owns measured capacity and forecast standing.
// All drawing is local and bounded; no percentage is depleted by this renderer.
export function drawAllowanceTank(
  canvas,
  {
    remaining,
    pace,
    time = 0,
    waves = [0, 0, 0],
    agitation = 0,
    colors,
    width,
    height = 556,
    flowEnabled = true,
    dpr = 1,
    widthScale = 1,
  },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const scale = height / 556;
  width /= scale;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  // No forecast uses the owner-selected gentle idle visual, never a forecast value.
  const state = { pace: pace === null ? 0.55 : Math.max(0.1, Math.min(5, pace)) };
  const activity = Math.min(4, Math.max(0, state.pace - 0.65) * 1.8);
  const vessel = {
    x: width / 2,
    y: 96,
    w: Math.min(188, width - 64) * widthScale,
    h: 220,
  };
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
    const position = px / p.w;
    const ripple = Math.cos(position * Math.PI) * Math.sin(time * 0.9 + offset) * 0.2
      + Math.cos(position * Math.PI * 2) * Math.sin(time * (1.4 + activity) + offset) * (0.1 + activity * 0.45)
      + Math.cos(position * Math.PI * 4) * Math.sin(time * (2 + activity) + offset) * activity * 0.45;
    const disturbance = waves.reduce((sum, amplitude, index) => (
      sum + amplitude * Math.cos((index + 1) * Math.PI * position)
    ), 0);
    return base + (ripple + disturbance) * edge;
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
    ctx.clearRect(0, 0, width, 556);
    {
      const p = vessel,
        left = p.x - p.w / 2,
        right = p.x + p.w / 2,
        bottom = p.y + p.h;
      const { fluid: fuel, glow, deep } = colors;
      {
        ctx.save();
        const haloY = p.y + p.h * 0.7;
        const haloRadius = Math.max(16, Math.min(p.w * 0.85, width / 2 - 2, haloY - 2, 556 - haloY - 2));
        const halo = ctx.createRadialGradient(
          p.x,
          haloY,
          15,
          p.x,
          haloY,
          haloRadius,
        );
        halo.addColorStop(0, alpha(fuel, state.pace >= 2 ? 0.24 : 0.09));
        halo.addColorStop(1, alpha(fuel, 0));
        ctx.fillStyle = halo;
        // Paint the full gradient diameter so its rectangular bounds are transparent.
        ctx.fillRect(p.x - haloRadius, haloY - haloRadius, haloRadius * 2, haloRadius * 2);
        ctx.restore();
      }
      // A soft shadow gives the engine mount depth beneath the fuselage.
      ctx.save();
      ctx.fillStyle = alpha(colors.shadow, 0.16);
      ctx.filter = "blur(10px)";
      ctx.beginPath();
      ctx.ellipse(p.x, bottom + 26, p.w * 0.57, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Stabilizer fins sit behind the glass and give the vessel a rocket-stage silhouette.
      for (const sign of [-1, 1]) {
        const side = p.x + sign * p.w / 2;
        const reach = Math.min(40, p.w * 0.26, (width - p.w) / 2 - 5);
        const fin = ctx.createLinearGradient(side, 0, side + sign * reach, 0);
        fin.addColorStop(0, colors.metal);
        fin.addColorStop(1, colors.edge);
        ctx.beginPath();
        ctx.moveTo(side - sign * 3, bottom - 88);
        ctx.lineTo(side + sign * reach, bottom + 30);
        ctx.lineTo(side + sign * reach * 0.4, bottom + 24);
        ctx.lineTo(side - sign * 10, bottom - 5);
        ctx.closePath();
        ctx.fillStyle = fin;
        ctx.fill();
        ctx.strokeStyle = alpha(colors.bright, 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
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
      // Bubble density and buoyancy make pace legible independently of colour.
      // Unknown pace shares the gentle idle appearance; it stays unknown to the caller.
      const bubbleCount = Math.min(44, Math.max(3, Math.round(state.pace ** 2 * 10)));
      const riseSpeed = Math.min(90, 2 + state.pace ** 2 * 8);
      const fluidDepth = Math.max(1, p.h * remaining / 100);
      for (let b = 0; b < bubbleCount; b++) {
        const bx = left + 12 + ((b * 47) % (p.w - 24)),
          travel = (time * riseSpeed * (0.75 + (b % 4) * 0.16) + b * 21) % fluidDepth,
          by = bottom - travel;
        const radius = 0.8 + (b % 3) * (0.4 + activity * 0.25);
        const bubbleX = bx + Math.sin(time * state.pace + b) * (1 + activity * 0.8);
        if (by > waveY(bubbleX - left, p, 0) + radius + 2) {
          ctx.beginPath();
          ctx.arc(
            bubbleX,
            by,
            radius,
            0,
            Math.PI * 2,
          );
          ctx.fillStyle = alpha(glow, 0.1 + activity * 0.035);
          ctx.fill();
          ctx.strokeStyle = alpha(glow, 0.2 + activity * 0.09);
          ctx.lineWidth = 0.75;
          ctx.stroke();
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
      // An ogive nose and swept fins make a continuous rocket silhouette.
      // The opaque nose sits above the measured, constant-height fuel chamber.
      const nose = ctx.createLinearGradient(left, 0, right, 0);
      nose.addColorStop(0, colors.edge);
      nose.addColorStop(0.3, colors.bright);
      nose.addColorStop(0.53, colors.metal);
      nose.addColorStop(1, colors.edge);
      ctx.beginPath();
      ctx.moveTo(left, p.y - 7);
      ctx.bezierCurveTo(left + p.w * 0.08, p.y - 40, p.x - p.w * 0.16, 22, p.x, 4);
      ctx.bezierCurveTo(p.x + p.w * 0.16, 22, right - p.w * 0.08, p.y - 40, right, p.y - 7);
      ctx.closePath();
      ctx.fillStyle = nose;
      ctx.fill();
      ctx.strokeStyle = alpha(colors.bright, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      // A subtle panel seam follows the nose curvature.
      ctx.beginPath();
      ctx.moveTo(p.x, 6);
      ctx.bezierCurveTo(p.x - p.w * 0.12, 32, p.x - p.w * 0.16, 62, p.x - p.w * 0.18, p.y - 8);
      ctx.strokeStyle = alpha(colors.shadow, 0.2);
      ctx.stroke();
      rounded(left - 5, bottom - 8, p.w + 10, 17, 6);
      ctx.fillStyle = metal;
      ctx.fill();
      for (const sign of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(p.x + sign * (p.w / 2 - 10), bottom, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.shadow;
        ctx.fill();
      }
      // A bell nozzle replaces the collecting basin. Only admitted forecast pace
      // colours the plume; an unavailable forecast uses a gentle decorative idle.
      const throatY = bottom + 17;
      const outletY = bottom + 94;
      const nozzleHalf = Math.min(92, p.w * 0.49);
      const throatHalf = Math.max(8, nozzleHalf * 0.29);
      const flowing = flowEnabled && remaining > 0;
      const rate = state.pace;
      ctx.fillStyle = colors.metal;
      rounded(p.x - throatHalf - 4, bottom + 7, throatHalf * 2 + 8, 15, 4);
      ctx.fill();
      const nozzle = ctx.createLinearGradient(p.x - nozzleHalf, 0, p.x + nozzleHalf, 0);
      nozzle.addColorStop(0, colors.edge);
      nozzle.addColorStop(0.2, colors.metal);
      nozzle.addColorStop(0.48, alpha(colors.bright, 0.7));
      nozzle.addColorStop(0.65, colors.metal);
      nozzle.addColorStop(1, colors.edge);
      ctx.beginPath();
      ctx.moveTo(p.x - throatHalf, throatY);
      ctx.bezierCurveTo(p.x - throatHalf, throatY + 20, p.x - nozzleHalf * 0.6, outletY - 5, p.x - nozzleHalf, outletY);
      ctx.lineTo(p.x + nozzleHalf, outletY);
      ctx.bezierCurveTo(p.x + nozzleHalf * 0.6, outletY - 5, p.x + throatHalf, throatY + 20, p.x + throatHalf, throatY);
      ctx.closePath();
      ctx.fillStyle = nozzle;
      ctx.fill();
      ctx.strokeStyle = alpha(colors.edge, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
      // Cooling ribs follow the flare of the nozzle.
      for (let rib = 1; rib <= 4; rib++) {
        const q = rib / 5;
        const half = throatHalf + (nozzleHalf - throatHalf) * q * q;
        ctx.beginPath();
        ctx.moveTo(p.x - half, throatY + q * (outletY - throatY));
        ctx.lineTo(p.x + half, throatY + q * (outletY - throatY));
        ctx.strokeStyle = alpha(colors.shadow, 0.28);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(p.x, outletY, nozzleHalf, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = colors.shadow;
      ctx.fill();
      ctx.strokeStyle = alpha(colors.bright, 0.55);
      ctx.stroke();
      if (flowing) {
        // A bounded pressure pulse follows slosh energy, without altering forecast pace.
        const pulse = Math.max(0, Math.min(1, agitation));
        const length = Math.min(138, Math.min(130, 12 + rate ** 1.5 * 55) * (1 + pulse * 0.42));
        const spread = nozzleHalf * Math.min(0.98, Math.min(0.94, 0.08 + rate * 0.38) * (1 + pulse * 0.25));
        const speed = 0.7 + rate * 1.4;
        const plumeY = outletY + 2;
        const center = (q) => p.x + Math.sin(time * (3 + activity) - q * 7) * q * (0.5 + activity + pulse * 3) + (waves[0] ?? 0) * 0.45 * q * q;
        const radius = (q) => spread * (1 - q) * (1 + (0.03 + activity * 0.04 + pulse * 0.1) * Math.sin(q * 16 - time * (6 + activity * 2)));
        const plume = ctx.createLinearGradient(0, plumeY, 0, plumeY + length);
        plume.addColorStop(0, alpha(glow, 0.95));
        plume.addColorStop(0.2, alpha(fuel, 0.8));
        plume.addColorStop(0.65, alpha(fuel, 0.32 + pulse * 0.2));
        plume.addColorStop(1, alpha(fuel, 0));
        ctx.save();
        ctx.beginPath();
        for (let step = 0; step <= 32; step++) {
          const q = step / 32;
          if (step === 0) ctx.moveTo(center(q) - radius(q), plumeY);
          else ctx.lineTo(center(q) - radius(q), plumeY + q * length);
        }
        for (let step = 32; step >= 0; step--) {
          const q = step / 32;
          ctx.lineTo(center(q) + radius(q), plumeY + q * length);
        }
        ctx.closePath();
        ctx.fillStyle = plume;
        ctx.shadowColor = fuel;
        ctx.shadowBlur = 10 + pulse * 8;
        ctx.fill();
        ctx.shadowBlur = 0;
        // Highlights travel downstream continuously, including below sustainable pace.
        for (let streak = 0; streak < 16; streak++) {
          const q = (time * speed + streak / 16) % 1;
          const lane = Math.sin(streak * 2.4) * 0.65;
          ctx.beginPath();
          ctx.moveTo(center(q) + lane * radius(q), plumeY + q * length);
          const end = Math.min(1, q + 0.07);
          ctx.lineTo(center(end) + lane * radius(end), plumeY + end * length);
          ctx.strokeStyle = alpha(glow, (1 - q) * 0.55);
          ctx.lineWidth = 0.8 + (streak % 3) * 0.4;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.ellipse(p.x, outletY + 1, spread, 2.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = alpha(glow, 0.9);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  draw();
  return true;
}
