(function (root) {
  'use strict';

  function fromReplay(replay) {
    const slots = replay.slots.map(slot => ({ ...slot }));
    // Unseen positions use the perspective of neighboring seats and a stricter
    // match threshold. The replay profile retains only the calibrated slots.
    slots.push(
      { seat: 3, slot: 1, x: 1321, y: 1028, w: 38, h: 26, u: -0.14, v: 0.49, minScore: 0.88, minMargin: 0.15 },
      { seat: 3, slot: 2, x: 1332, y: 981, w: 37, h: 25, u: -0.14, v: 0.49, minScore: 0.88, minMargin: 0.15 }
    );
    const steps = {
      1: [-18, -15], 2: [-10, -19], 3: [-7, -20], 4: [13, -23],
      5: [18, -19], 6: [34, -16], 7: [39, -15],
    };
    for (let seat = 1; seat <= 7; seat++) {
      let last = slots.filter(slot => slot.seat === seat).sort((a, b) => b.slot - a.slot)[0];
      const [dx, dy] = steps[seat];
      while (last.slot < 5) {
        last = { seat, slot: last.slot + 1, x: last.x + dx, y: last.y + dy, w: last.w, h: last.h,
          u: last.u, v: last.v, minScore: 0.90, minMargin: 0.17 };
        slots.push(last);
      }
    }
    slots.sort((a, b) => a.seat - b.seat || a.slot - b.slot);
    return { ...replay, slots, maxFrameGapSeconds: 0.24, openingSeconds: 0.38 };
  }

  function forCapture(replay, augment) {
    const reference = fromReplay(replay);
    return { ...reference, templates: augment(reference.templates),
      liveSearch: { minScore: 0.83, minMargin: 0.10 }, maxFrameGapSeconds: 0.42 };
  }

  function forCloseCapture(reference, publicTens = []) {
    // Geometry from a 2332 × 1308 Classic close view. This preset has its
    // own calibration so the wider Classic reference remains available.
    const centers = [
      [[1116, 792]], [[1579, 925], [1565, 892]],
      [[1467, 977], [1448, 934], [1438, 892]], [[1307, 1012], [1314, 963], [1353, 926]],
      [[1139, 1018], [1172, 980], [1207, 945]], [[949, 1000], [990, 968]],
    ];
    const scaleX = reference.width / 2332;
    const scaleY = reference.height / 1308;
    function position(x, y) {
      return { x: x * scaleX, y: y * scaleY };
    }
    const openingSlots = reference.slots.filter(slot => slot.slot === 1);
    const slots = reference.slots.map(slot => {
      const center = centers[slot.seat]?.[slot.slot - 1];
      if (slot.seat === 0) {
        if (slot.slot === 2) {
          // A revealed hole card may overlap the upcard and sit higher than
          // the face-down position. Keep these views on its leading corner.
          const reveal = [
            { ...position(1158, 791), w: 29, h: 22, u: 0, v: 0, minBright: 0.42, minScore: 0.83, minMargin: 0.09, holeReveal: true },
            { ...position(1162, 790), w: 24, h: 17, u: 0, v: 0, minBright: 0.48, minScore: 0.82, minMargin: 0.10, holeReveal: true },
            // Catch both digits when a revealed 10 comes to rest next to the upcard.
            { ...position(1168, 792), w: 41, h: 19, u: 0, v: 0, inkCeiling: 150, minBright: 0.35, minPairedScore: 0.81,
              holeReveal: true, pairedOnly: true },
          ];
          return { ...slot, variants: [...(slot.variants ?? []), ...reveal] };
        }
        if (!center) return slot;
        const restingUpcard = position(...center);
        const movingUpcard = { ...position(1306, 839), w: 43, h: 24, u: -0.22, v: 0.83 };
        const betweenUpcard = { x: (restingUpcard.x + movingUpcard.x) / 2, y: restingUpcard.y,
          w: 43, h: 22, u: -0.10, v: 0.64, inkCeiling: 152, minScore: 0.83, minMargin: 0.12 };
        return { ...slot, ...restingUpcard, variants: [movingUpcard, betweenUpcard] };
      }
      const { u, v } = openingSlots.find(opening => opening.seat === slot.seat) ?? slot;
      const calibrated = center ? { ...slot, ...position(...center), u, v, variants: undefined } : slot;
      const contrast = {
        inkCeiling: 152, minBright: 0.34,
        minScore: Math.max(calibrated.minScore ?? 0.72, 0.82),
        minMargin: Math.max(calibrated.minMargin ?? 0.075, 0.10),
      };
      const variants = [...(calibrated.variants ?? []), contrast];
      if (calibrated.slot <= 3) {
        // The two-character 10 is wider than a normal index. The wider
        // window may only emit a paired glyph, never a partial single rank.
        variants.unshift({
          x: Math.round(calibrated.x + 2), y: Math.round(calibrated.y - 1),
          w: Math.max(54, Math.round(calibrated.w * 1.43)), h: Math.max(32, calibrated.h + 4),
          v: calibrated.v * 1.7, inkCeiling: 152, minBright: 0.35, pairedOnly: true, minPairedScore: 0.84,
        });
      }
      const flip = calibrated.seat === 2 && calibrated.slot === 3 ? { flip: false } : {};
      return { ...calibrated, ...flip, minBright: 0.33, variants };
    });
    const templates = { ...reference.templates };
    templates['10'] = [...(templates['10'] ?? []), ...publicTens];
    return { ...reference, slots, templates, liveSearch: { ...reference.liveSearch, relocate: true } };
  }

  const api = { fromReplay, forCapture, forCloseCapture };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackLiveProfile = api;
}(globalThis));
