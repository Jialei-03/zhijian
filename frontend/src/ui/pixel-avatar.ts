/**
 * Pixel animal avatars: one seed, one animal, endlessly many seeds.
 * A 16×16 grid drawn symmetrically (accessories may break symmetry).
 */
const N = 16;

type Grid = (string | null)[][];
type Rand = () => number;

export const SPECIES = [
  "cat",
  "fox",
  "bear",
  "rabbit",
  "mouse",
  "dog",
  "owl",
  "frog",
  "panda",
  "chick",
  "pig",
  "penguin",
] as const;
export type Species = (typeof SPECIES)[number];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function random(seed: string): Rand {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: Rand, items: readonly T[]): T =>
  items[Math.floor(r() * items.length)];
const between = (r: Rand, low: number, high: number) =>
  low + r() * (high - low);

function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

interface Palette {
  body: string;
  outline: string;
  light: string;
  inner: string;
  accent: string;
  dark: string;
  background: string;
}

function palette(r: Rand, species: Species): Palette {
  const base: Record<Species, [number, number, number, number]> = {
    // hue low, hue high, saturation, lightness
    cat: [20, 40, 45, 62],
    fox: [14, 28, 78, 56],
    bear: [22, 34, 40, 45],
    rabbit: [0, 360, 12, 86],
    mouse: [0, 360, 6, 72],
    dog: [26, 42, 50, 60],
    owl: [24, 36, 38, 48],
    frog: [90, 140, 52, 52],
    panda: [0, 0, 0, 96],
    chick: [44, 54, 92, 66],
    pig: [340, 356, 70, 82],
    penguin: [210, 230, 22, 24],
  };
  const [h0, h1, s0, l0] = base[species];
  // Rare fantasy colours keep the space open-ended.
  const fantasy = r() < 0.12;
  const h = fantasy ? between(r, 0, 360) : between(r, h0, h1);
  const s = fantasy
    ? between(r, 45, 70)
    : Math.max(0, s0 + between(r, -10, 10));
  const l = Math.min(92, Math.max(18, l0 + between(r, -8, 8)));
  return {
    body: hsl(h, s, l),
    outline: hsl(h, Math.min(60, s + 5), Math.max(10, l * 0.42)),
    light: hsl(h, s * 0.5, Math.min(96, l + 26)),
    inner: hsl(350, 70, 80),
    accent: hsl(between(r, 0, 360), 70, 58),
    dark: hsl(h, 25, 14),
    background: hsl(between(r, 0, 360), 45, 92),
  };
}

function blank(): Grid {
  return Array.from({ length: N }, () => Array<string | null>(N).fill(null));
}

function draw(
  r: Rand,
  species: Species,
  p: Palette,
): { grid: Grid; background: string } {
  const g = blank();
  const put = (x: number, y: number, c: string | null) => {
    if (x >= 0 && x < N && y >= 0 && y < N) g[y][x] = c;
  };
  const both = (x: number, y: number, c: string | null) => {
    put(x, y, c);
    put(N - 1 - x, y, c);
  };

  const cy = species === "rabbit" ? 10 : between(r, 8.6, 9.6);
  const rx = species === "frog" ? between(r, 6.4, 7) : between(r, 5.4, 6.4);
  const ry =
    species === "chick" || species === "owl"
      ? between(r, 5.6, 6.2)
      : between(r, 4.6, 5.6);
  const inHead = (x: number, y: number) =>
    ((x + 0.5 - N / 2) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;

  // Ears and other parts behind the head.
  const ear = (cells: [number, number][], c: string) =>
    cells.forEach(([x, y]) => both(x, y, c));
  const eh = Math.round(cy - ry);
  if (species === "cat" || species === "pig" || species === "fox") {
    // Solid triangles: apex outside, widening towards the head.
    const tall = species === "fox" ? 4 : species === "pig" ? 2 : 3;
    const ex = species === "fox" ? 2 : 3;
    for (let k = 0; k < tall; k++) {
      const y = eh - tall + 1 + k;
      for (let x = ex; x <= ex + k + 1; x++) both(x, y, p.body);
      for (let x = ex + 1; x <= ex + k; x++) if (k >= 1) both(x, y, p.inner);
    }
  } else if (species === "bear" || species === "panda" || species === "mouse") {
    const radius = species === "mouse" ? 2.4 : 1.6;
    const ex = species === "mouse" ? 2.5 : 3.5;
    const ey = eh + (species === "mouse" ? 0.5 : 0.8);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N / 2; x++) {
        const d = Math.hypot(x + 0.5 - ex, y + 0.5 - ey);
        if (d <= radius) both(x, y, species === "panda" ? p.dark : p.body);
        if (d <= radius - 1 && species !== "panda") both(x, y, p.inner);
      }
  } else if (species === "rabbit") {
    const ex = Math.round(between(r, 4, 5));
    for (let y = 0; y < eh + 1; y++) {
      both(ex, y, p.body);
      both(ex + 1, y, y > 0 ? p.inner : p.body);
    }
  } else if (species === "owl") {
    both(4, eh - 1, p.outline);
    both(3, eh - 2, p.outline);
  } else if (species === "chick") {
    put(7, eh - 1, p.body);
    put(8, eh - 2, p.body);
    put(7, eh - 2, p.body);
  }

  // Head with outline.
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) if (inHead(x, y)) put(x, y, p.body);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (
        g[y][x] &&
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx < 0 || ny < 0 || nx >= N || ny >= N || !g[ny][nx];
        })
      )
        g[y][x] = p.outline;

  if (species === "dog") {
    const ey = Math.round(cy - ry + 1);
    for (let y = ey; y < ey + 5; y++) {
      both(Math.round(N / 2 - rx) - 1, y, p.outline);
      both(Math.round(N / 2 - rx), y, p.dark);
    }
  }

  // Face marks.
  const eyeY = Math.round(cy - between(r, 0.2, 1.2));
  const eyeX = Math.round(between(r, 4, 5.4));
  if (species === "panda") {
    for (let y = eyeY - 1; y <= eyeY + 1; y++) {
      both(eyeX - 1, y, p.dark);
      both(eyeX, y, p.dark);
    }
  }
  if (species === "penguin") {
    for (let y = eyeY - 1; y < N; y++)
      for (let x = 4; x < N / 2; x++)
        if (inHead(x, y) && g[y][x] !== p.outline && (x > 4 || y > eyeY))
          both(x, y, p.light);
  }
  if (
    species === "fox" ||
    species === "dog" ||
    species === "bear" ||
    species === "cat"
  ) {
    for (let y = eyeY + 1; y < N; y++)
      for (let x = 5; x < N / 2; x++)
        if (inHead(x, y) && g[y][x] !== p.outline && r() < 0.95)
          both(x, y, p.light);
  }
  // Stripes or spots on the forehead.
  const pattern = r();
  if (
    ["cat", "fox", "dog", "bear", "mouse", "frog"].includes(species) &&
    pattern < 0.35
  ) {
    const top = Math.round(cy - ry) + 1;
    for (let i = 0; i < 3; i++) put(6 + i, top + (i % 2), p.outline);
    put(9, top, p.outline);
  } else if (pattern < 0.5 && species !== "panda" && species !== "penguin") {
    put(Math.round(between(r, 3, 6)), Math.round(cy + 1), p.light);
    put(Math.round(between(r, 10, 12)), Math.round(cy - 1), p.light);
  }

  // Eyes.
  const eyeStyle = pick(r, [
    "dot",
    "tall",
    "shine",
    "shine",
    "sleepy",
    "big",
  ] as const);
  const eye = species === "owl" || species === "frog" ? "big" : eyeStyle;
  const pupil = species === "panda" ? "#fff" : p.dark;
  if (eye === "dot") both(eyeX, eyeY, pupil);
  if (eye === "tall") {
    both(eyeX, eyeY, pupil);
    both(eyeX, eyeY + 1, pupil);
  }
  if (eye === "shine") {
    both(eyeX, eyeY, pupil);
    both(eyeX, eyeY + 1, pupil);
    both(eyeX + 1, eyeY + 1, pupil);
    both(eyeX + 1, eyeY, species === "panda" ? p.dark : "#fff");
  }
  if (eye === "sleepy") {
    both(eyeX - 1, eyeY + 1, pupil);
    both(eyeX, eyeY + 1, pupil);
  }
  if (eye === "big") {
    const ey = species === "frog" ? Math.round(cy - ry) : eyeY;
    for (let y = ey - 1; y <= ey + 1; y++)
      for (let x = eyeX - 1; x <= eyeX + 1; x++) both(x, y, "#fff");
    both(eyeX, ey, p.dark);
    both(eyeX - 1, ey - 1, p.outline);
    both(eyeX + 1, ey - 1, p.outline);
  }

  // Nose, beak or mouth.
  const mouthY = Math.min(N - 2, eyeY + 2 + (r() < 0.5 ? 1 : 0));
  if (species === "owl" || species === "chick" || species === "penguin") {
    put(7, mouthY, "hsl(36 95% 55%)");
    put(8, mouthY, "hsl(36 95% 55%)");
    put(7, mouthY + 1, "hsl(30 90% 45%)");
    put(8, mouthY + 1, "hsl(30 90% 45%)");
  } else if (species === "pig") {
    for (let x = 6; x <= 9; x++) {
      put(x, mouthY, p.inner);
      put(x, mouthY + 1, p.inner);
    }
    put(6, mouthY, p.outline);
    put(9, mouthY, p.outline);
    put(7, mouthY + 1, p.outline);
    put(8, mouthY + 1, p.outline);
  } else if (species === "frog") {
    for (let x = 5; x <= 10; x++) put(x, mouthY + 1, p.outline);
  } else {
    put(7, mouthY, p.dark);
    put(8, mouthY, p.dark);
    if (r() < 0.6) {
      put(6, mouthY + 1, p.outline);
      put(9, mouthY + 1, p.outline);
    }
  }
  if (r() < 0.55) both(eyeX - 1, eyeY + 2, "hsl(350 80% 76%)");

  // Accessories.
  const extra = r();
  const top = Math.round(cy - ry);
  if (extra < 0.14) {
    // Beanie
    const c = p.accent;
    for (let x = 4; x <= 11; x++) {
      put(x, top, c);
      put(x, top - 1, c);
    }
    for (let x = 5; x <= 10; x++) put(x, top - 2, c);
    put(7, top - 3, "#fff");
    put(8, top - 3, "#fff");
  } else if (extra < 0.24) {
    // Glasses
    for (let x = eyeX - 1; x <= eyeX + 1; x++) {
      both(x, eyeY - 1, p.dark);
      both(x, eyeY + 2, p.dark);
    }
    both(eyeX - 2, eyeY, p.dark);
    both(eyeX - 2, eyeY + 1, p.dark);
    for (let x = eyeX + 2; x < N / 2; x++) both(x, eyeY, p.dark);
  } else if (extra < 0.32) {
    // Headphones
    for (let x = 4; x <= 11; x++) put(x, top - 1, p.dark);
    for (let y = Math.round(cy) - 1; y <= Math.round(cy) + 1; y++) {
      both(Math.round(N / 2 - rx) - 1, y, p.accent);
      both(Math.round(N / 2 - rx), y, p.accent);
    }
  } else if (extra < 0.4) {
    // Bow on one side
    const bx = 11;
    const by = top;
    [
      [bx, by],
      [bx + 1, by - 1],
      [bx + 1, by + 1],
      [bx - 1, by - 1],
      [bx - 1, by + 1],
    ].forEach(([x, y]) => put(x, y, p.accent));
  } else if (extra < 0.46) {
    // Sprout
    put(8, top - 1, "hsl(110 55% 40%)");
    put(8, top - 2, "hsl(110 55% 40%)");
    put(9, top - 3, "hsl(110 60% 50%)");
    put(7, top - 3, "hsl(110 60% 50%)");
  } else if (extra < 0.5) {
    // Crown
    const c = "hsl(45 95% 55%)";
    for (let x = 5; x <= 10; x++) put(x, top - 1, c);
    [5, 7, 8, 10].forEach((x) => put(x, top - 2, c));
    put(5, top - 3, c);
    put(10, top - 3, c);
  }

  return { grid: g, background: p.background };
}

export interface PixelAvatarData {
  species: Species;
  grid: Grid;
  background: string;
}

export function pixelAvatar(seed: string): PixelAvatarData {
  const r = random(seed);
  const species = pick(r, SPECIES);
  return { species, ...draw(r, species, palette(r, species)) };
}

/** Standalone SVG markup, crisp at any size. */
export function pixelAvatarSvg(seed: string, background = true): string {
  const { grid, background: bg } = pixelAvatar(seed);
  const rects: string[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < N) {
      const c = row[x];
      let w = 1;
      while (c && x + w < N && row[x + w] === c) w++;
      if (c)
        rects.push(
          `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c}"/>`,
        );
      x += w;
    }
  });
  return (
    // A margin keeps ears and hats inside a circular crop.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2.5 ${N + 4} ${N + 4}" shape-rendering="crispEdges">` +
    (background
      ? `<rect x="-2" y="-2.5" width="${N + 4}" height="${N + 4}" fill="${bg}"/>`
      : "") +
    rects.join("") +
    "</svg>"
  );
}

/** A new random seed for "another one". */
export const newAvatarSeed = () => Math.random().toString(36).slice(2, 10);
