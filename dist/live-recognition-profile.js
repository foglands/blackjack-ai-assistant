(function (root) {
  'use strict';

  // Reviewed rank masks from the opening round of a local Classic recording.
  // The two later test intervals supplied no training pixels.
  const closeGlyphs = {
    "2": [[32,1020,2014,3855,7695,7695,15,15,30,60,120,496,960,1920,3840,15872,32512,65534,24574,2]],
    "3": [[4080,8190,15902,6159,31,31,30,62,504,376,62,30,24607,61471,63519,63519,64766,32764,8168,512],[992,4094,3870,7198,15,14,14,124,248,120,120,60,24606,61502,28734,61500,32380,8184,8176,384]],
    "4": [[14,62,124,124,496,992,4032,7808,31804,32316,32316,65340,4094,255,254,248,240,240,496,224]],
    "5": [[7808,8190,8191,8063,7680,15360,15360,16000,16368,8188,126,62,30,30,49182,61470,63518,32504,16376,120]],
    "6": [[192,192,960,1984,1984,3968,8064,8064,16376,32316,32316,63518,63519,63519,63519,30750,30750,16380,992,992],[14,62,124,240,240,1504,2016,4064,8188,31262,30750,30735,61455,28687,61455,28702,30844,15612,16368,896],[3,15,126,252,504,504,1008,4080,8188,15934,30782,61455,61455,61455,61454,61454,31774,32766,8188,32]],
    "8": [[32,4064,8176,8176,30720,30744,63544,14392,8184,4088,4088,3992,7936,7680,7174,7687,7943,7943,4094,720]],
    "9": [[2044,2044,14366,30735,30735,61455,61455,63502,30748,30748,16380,16380,1008,480,480,960,960,1792,1792,1792],[1008,4092,7742,15374,14351,28687,28686,30734,30734,15390,15390,8060,4080,4032,3968,3840,15872,30720,61440,24576],[60,510,510,7711,6159,12295,12295,24582,61440,63544,63544,32736,16320,7936,7936,7680,4096,57344,57344,49152]],
    "A": [[7680,15872,16128,16128,16256,15744,14528,14432,14432,30816,30968,16344,31758,31758,30734,28703,30724,63488,63488,57344]],
    "Q": [[128,8048,14344,14344,28684,28684,28678,24582,24582,64526,64526,29582,24654,24700,12348,4156,3324,3324,845,3]],
    "K": [[31788,31870,31870,31870,14456,30960,31200,32704,32704,32704,32704,15584,14432,14432,14456,30780,31804,64572,64572,6207],[15104,16156,7711,7711,7228,7288,7408,8160,16320,16352,16352,14816,14560,30944,30832,63600,63608,30840,124,28],[256,448,391,262,262,536,792,3936,4032,4032,4032,4544,12480,12480,12480,45280,61664,20960,496,32]],
    "J": [[16,31,30,30,28,28,28,56,56,48,112,112,224,224,57568,57824,62400,32512,32512,3072]],
  };
  const filmedTens = [[32768,32768,49278,49279,49255,49347,32963,32771,32771,32867,32963,32963,32963,32835,32839,32962,32963,32891,32830,32768]];

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
    // Strongly sheared views can lose thin strokes on the default pixel grid.
    // These wide-preset slots get a second sampling phase at the same anchor.
    const phases = { '3:2': 0.5, '7:1': 0.25 };
    const slots = reference.slots.map(slot => {
      const rankPhaseY = phases[`${slot.seat}:${slot.slot}`];
      return rankPhaseY ? { ...slot, rankPhaseY } : slot;
    });
    return { ...reference, slots, templates: augment(reference.templates),
      liveSearch: { minScore: 0.83, minMargin: 0.10 }, maxFrameGapSeconds: 0.42 };
  }

  function forCloseCapture(reference, augment = samples => samples, publicTens = []) {
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
    const slots = reference.slots.map(({ rankPhaseY, ...slot }) => {
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
    for (const [rank, rows] of Object.entries(augment(closeGlyphs))) {
      templates[rank] = [...(templates[rank] ?? []), ...rows];
    }
    templates['10'] = [...(templates['10'] ?? []), ...publicTens, ...filmedTens];
    return { ...reference, slots, templates, liveSearch: { ...reference.liveSearch, relocate: true } };
  }

  function forFrontCapture(reference, augment, publicTens) {
    const close = forCloseCapture(reference, augment, publicTens);
    // Full-table camera view. These are leading rank corners in screen order,
    // rather than chip positions or positions inferred from the table number.
    const openings = [
      [[1098, 803], [1203, 804], [1244, 805], [1270, 805]],
      [[1621, 929], [1615, 902], [1567, 895]],
      [[1485, 997], [1475, 952]],
      [[1340, 1036], [1358, 986]],
      [[1151, 1046], [1190, 997]],
      [[965, 1032], [1042, 992], [1105, 957]],
      [[816, 990], [891, 962]],
      [[699, 914], [779, 902]],
    ];
    const shear = [[0, 0], [-0.33, 1.43], [-0.22, 0.88], [-0.14, 0.49],
      [-0.03, 0.12], [0.13, -0.50], [0.25, -0.87], [0.34, -1.48]];
    const offsets = [[0, 0], [-17, -23], [-12, -28], [-3, -28], [13, -27], [19, -23], [30, -19], [38, -16]];
    // A few positions have a different slant or a partly covered leading
    // corner as the dealer fans the hand. Try these local views before searching.
    const localViews = {
      '0:1': [[1165, 804, 33, 23, 0, 0], [1169, 804, 37, 25, -0.12, 0],
        [1111, 830, 38, 23, 0.20, -0.40, 120, true]],
      '0:2': [[1203, 808, 49, 28, 0, 0.55], [1203, 804, 42, 29, 0, 0.30],
        [1211, 808, 49, 26, 0.18, -0.50, 125]],
      '0:3': [[1244, 809, 49, 28, 0, 0.30]],
      '0:4': [[1274, 805, 42, 29, 0.12, 0.30]],
      '1:1': [[1629, 929, 33, 22, -0.45, 1.43], [1621, 929, 39, 25, -0.33, 1.13]],
      '1:2': [[1611, 898, 32, 26, -0.45, 1.65, 168], [1688, 920, 43, 22, -0.45, 1.65, 136, true]],
      '1:3': [[1561, 894, 28, 20, -0.55, 1.68], [1640, 910, 22, 25, -0.55, 1.68, 152, true]],
      '2:1': [[1497, 997, 42, 29, -0.34, 0.88]],
      '2:2': [[1499, 952, 42, 29, -0.34, 0.88]],
      '3:1': [[1342, 1036, 46, 29, -0.05, 0.30, 136]],
      '3:2': [[1362, 986, 49, 28, -0.14, 0.19], [1366, 986, 49, 28, -0.02, 0.49]],
      '4:1': [[1155, 1046, 49, 28, -0.03, -0.18]],
      '4:2': [[1198, 997, 49, 28, -0.03, 0.12]],
      '5:1': [[965, 1032, 49, 28, 0.01, -0.50]],
      '5:2': [[1050, 996, 49, 28, 0.13, -0.80]],
      '6:1': [[812, 990, 42, 29, 0.25, -1.17]],
      '6:2': [[899, 962, 42, 29, 0.37, -0.87]],
      '7:1': [[697, 920, 37, 22, 0.34, -1.70], [699, 914, 49, 28, 0.34, -1.78],
        [707, 918, 42, 29, 0.34, -2.03]],
      '7:2': [[784, 905, 35, 22, 0.58, -1.68, 168]],
    };
    const scaleX = reference.width / 2330, scaleY = reference.height / 1306;
    const slots = [];
    for (const [seat, corners] of openings.entries()) {
      const [u, v] = shear[seat];
      for (let slot = 1; slot <= (seat === 0 ? corners.length : 5); slot++) {
        const distance = Math.max(0, slot - corners.length);
        const [x, y] = corners[slot - 1] ?? corners.at(-1);
        const region = {
          seat, slot, x: (x + offsets[seat][0] * distance) * scaleX,
          y: (y + offsets[seat][1] * distance) * scaleY,
          w: seat === 0 ? 33 : 39, h: seat === 0 ? 23 : 25, u, v,
          minBright: 0.40, inkCeiling: 152,
          minScore: distance ? 0.88 : 0.81, minMargin: distance ? 0.14 : 0.10,
        };
        const pair = { w: 52, h: 30, pairedOnly: true, minBright: 0.36, minPairedScore: 0.84 };
        const variants = [pair, ...(localViews[`${seat}:${slot}`] ?? []).map(([x, y, w, h, u, v, inkCeiling = 152, flip = false]) => ({
          x: x * scaleX, y: y * scaleY, w, h, u, v, inkCeiling, flip, minBright: 0.37, minMargin: 0.085,
          fixedView: flip,
        }))];
        if (seat === 1 && slot === 1) {
          // The far rank can remain visible while the dealer's hand covers the
          // leading corner. Keep its search window away from the second card.
          variants.push({ x: 1709 * scaleX, y: 948 * scaleY, w: 34, h: 30, u: -0.35, v: 1.90,
            flip: true, inkCeiling: 145, minBright: 0.38, minScore: 0.84, minMargin: 0.11,
            fixedView: true, recoveryOnly: true });
        }
        if (seat === 0 && slot === 3) {
          variants.push({ ...pair, x: 1244 * scaleX, y: 806 * scaleY, w: 38, h: 20,
            inkCeiling: 160, minBright: 0.32, minPairedScore: 0.81, fixedView: true });
          variants.push({ ...pair, x: 1268 * scaleX, y: 836 * scaleY, w: 38, h: 20, v: 0.25,
            flip: true, minBright: 0.32, fixedView: true });
        }
        if (seat === 1 && slot === 3) region.followFan = false;
        slots.push({ ...region, variants });
      }
    }
    // The opposite corner can keep both digits readable after the hit cards overlap.
    const oppositeTen = [63488, 63736, 63736, 31230, 15238, 15239, 15239, 15239, 15235, 15111,
      15111, 15111, 15111, 15239, 15239, 29447, 15239, 14798, 14798, 252];
    return { ...close, slots, templates: { ...close.templates, 10: [...close.templates['10'], oppositeTen] },
      liveSearch: { ...close.liveSearch, guardRotatedRanks: true } };
  }

  const api = { fromReplay, forCapture, forCloseCapture, forFrontCapture };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlackjackLiveProfile = api;
}(globalThis));
