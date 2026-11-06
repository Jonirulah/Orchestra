// Temas de color del terminal. Módulo puro (sin Svelte/Tauri): se prueba con node --test.

export interface TermTheme {
  background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export const THEMES = {
  orchestra: {
    label: 'Orchestra Dark',
    theme: {
      background: '#0d0f12', foreground: '#d7dae0', cursor: '#f5b942', cursorAccent: '#0d0f12',
      selectionBackground: 'rgba(245,185,66,0.28)',
      black: '#1b1e24', red: '#ef6b73', green: '#8fcf7a', yellow: '#f5b942',
      blue: '#6cb2ff', magenta: '#c58af9', cyan: '#5fd4d4', white: '#d7dae0',
      brightBlack: '#5c6370', brightRed: '#ff8a91', brightGreen: '#a9e394', brightYellow: '#ffd076',
      brightBlue: '#8cc4ff', brightMagenta: '#d8a7ff', brightCyan: '#82e6e6', brightWhite: '#ffffff',
    },
  },
  dracula: {
    label: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: 'rgba(68,71,90,0.85)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  solarized: {
    label: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36',
      selectionBackground: 'rgba(147,161,161,0.25)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#657b83', brightYellow: '#839496',
      brightBlue: '#93a1a1', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  onedark: {
    label: 'One Dark',
    theme: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34',
      selectionBackground: 'rgba(82,139,255,0.28)',
      black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  gruvbox: {
    label: 'Gruvbox Dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: 'rgba(168,153,132,0.3)',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  // Paletas habituales de la comunidad (valores de sus proyectos de terminal), adaptadas a las 16 ANSI + cursor + selección.
  nord: {
    label: 'Nord',
    theme: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: 'rgba(136,192,208,0.28)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  tokyonight: {
    label: 'Tokyo Night',
    theme: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26',
      selectionBackground: 'rgba(122,162,247,0.28)',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  catppuccin: {
    label: 'Catppuccin Mocha',
    theme: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
      selectionBackground: 'rgba(147,153,178,0.3)',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  rosepine: {
    label: 'Rosé Pine',
    theme: {
      background: '#191724', foreground: '#e0def4', cursor: '#e0def4', cursorAccent: '#191724',
      selectionBackground: 'rgba(110,106,134,0.35)',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
      blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177',
      brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
  },
  monokai: {
    label: 'Monokai',
    theme: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822',
      selectionBackground: 'rgba(73,72,62,0.9)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  githubdark: {
    label: 'GitHub Dark',
    theme: {
      background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', cursorAccent: '#0d1117',
      selectionBackground: 'rgba(56,139,253,0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  everforest: {
    label: 'Everforest Dark',
    theme: {
      background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', cursorAccent: '#2d353b',
      selectionBackground: 'rgba(80,94,103,0.7)',
      black: '#475258', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f',
      blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#859289', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f',
      brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#e6dcc0',
    },
  },
  kanagawa: {
    label: 'Kanagawa',
    theme: {
      background: '#1f1f28', foreground: '#dcd7ba', cursor: '#c8c093', cursorAccent: '#1f1f28',
      selectionBackground: 'rgba(84,84,109,0.6)',
      black: '#16161d', red: '#c34043', green: '#76946a', yellow: '#c0a36e',
      blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384',
      brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
    },
  },
  nightowl: {
    label: 'Night Owl',
    theme: {
      background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2', cursorAccent: '#011627',
      selectionBackground: 'rgba(29,59,83,0.9)',
      black: '#011627', red: '#ef5350', green: '#22da6e', yellow: '#addb67',
      blue: '#82aaff', magenta: '#c792ea', cyan: '#21c7a8', white: '#ffffff',
      brightBlack: '#575656', brightRed: '#ef5350', brightGreen: '#22da6e', brightYellow: '#ffeb95',
      brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#7fdbca', brightWhite: '#ffffff',
    },
  },
  ayu: {
    label: 'Ayu Dark',
    theme: {
      background: '#0b0e14', foreground: '#bfbdb6', cursor: '#e6b450', cursorAccent: '#0b0e14',
      selectionBackground: 'rgba(64,159,255,0.25)',
      black: '#11151c', red: '#ea6c73', green: '#7fd962', yellow: '#f9af4f',
      blue: '#53bdfa', magenta: '#cda1fa', cyan: '#90e1c6', white: '#c7c7c7',
      brightBlack: '#686868', brightRed: '#f07178', brightGreen: '#aad94c', brightYellow: '#ffb454',
      brightBlue: '#59c2ff', brightMagenta: '#d2a6ff', brightCyan: '#95e6cb', brightWhite: '#ffffff',
    },
  },
  // Claros
  catppuccinlatte: {
    label: 'Catppuccin Latte (light)',
    theme: {
      background: '#eff1f5', foreground: '#4c4f69', cursor: '#1e66f5', cursorAccent: '#eff1f5',
      selectionBackground: 'rgba(124,127,147,0.28)',
      black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
      blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be',
      brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d',
      brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc',
    },
  },
  solarizedlight: {
    label: 'Solarized Light',
    theme: {
      background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', cursorAccent: '#fdf6e3',
      selectionBackground: 'rgba(147,161,161,0.3)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  gruvboxlight: {
    label: 'Gruvbox Light',
    theme: {
      background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7',
      selectionBackground: 'rgba(146,131,116,0.3)',
      black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
      brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614',
      brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#282828',
    },
  },
  githublight: {
    label: 'GitHub Light',
    theme: {
      background: '#ffffff', foreground: '#24292f', cursor: '#0969da', cursorAccent: '#ffffff',
      selectionBackground: 'rgba(9,105,218,0.2)',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
      blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01',
      brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
  onelight: {
    label: 'One Light',
    theme: {
      background: '#fafafa', foreground: '#383a42', cursor: '#526eff', cursorAccent: '#fafafa',
      selectionBackground: 'rgba(82,110,255,0.2)',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
      blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
      brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401',
      brightBlue: '#0184bc', brightMagenta: '#a626a4', brightCyan: '#0997b3', brightWhite: '#696c77',
    },
  },
  // Accesibilidad: contraste máximo.
  highcontrast: {
    label: 'High Contrast',
    theme: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffff00', cursorAccent: '#000000',
      selectionBackground: 'rgba(255,255,255,0.35)',
      black: '#000000', red: '#ff5f5f', green: '#5fff5f', yellow: '#ffff5f',
      blue: '#7f9fff', magenta: '#ff7fff', cyan: '#5fffff', white: '#e5e5e5',
      brightBlack: '#8a8a8a', brightRed: '#ff8787', brightGreen: '#87ff87', brightYellow: '#ffff87',
      brightBlue: '#9fb7ff', brightMagenta: '#ffa0ff', brightCyan: '#87ffff', brightWhite: '#ffffff',
    },
  },
} as const satisfies Record<string, { label: string; theme: TermTheme }>;

export type ThemeId = keyof typeof THEMES;
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
export const DEFAULT_THEME: ThemeId = 'orchestra';

export function themeOf(id: string): TermTheme {
  return (THEMES as Record<string, { theme: TermTheme }>)[id]?.theme ?? THEMES[DEFAULT_THEME].theme;
}

// ---------- temas propios (importados) ----------

/** Tema guardado/importado: colores #rrggbb en minúsculas. `ansi` son los 16 colores en el orden de ANSI_KEYS. */
export interface ThemeDef {
  /** `custom:<slug>`; único dentro de la lista. */
  id: string;
  name: string;
  background: string; foreground: string; cursor: string;
  /** Color de selección opaco; la capa del terminal le pone la transparencia (ver selectionCss). */
  selection: string;
  ansi: string[];
  custom?: true;
}

/** Entrada de la lista de temas (integrados + propios) para el selector. */
export interface ThemeEntry { id: string; label: string; custom: boolean; theme: TermTheme }

export const CUSTOM_PREFIX = 'custom:';
export const MAX_CUSTOM_THEMES = 50;

export function isCustomThemeId(id: unknown): id is string {
  return typeof id === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

/** El tema base: lo que rellena los huecos de un tema parcial. */
export function baseDef(): ThemeDef {
  const t = THEMES[DEFAULT_THEME].theme;
  return {
    id: 'orchestra', name: THEMES[DEFAULT_THEME].label,
    background: t.background, foreground: t.foreground, cursor: t.cursor, selection: '#f5b942',
    ansi: ANSI_KEYS.map((k) => t[k]),
  };
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16) || 0, parseInt(hex.slice(3, 5), 16) || 0, parseInt(hex.slice(5, 7), 16) || 0];
}

/** Selección con alfa: los tonos casi iguales al fondo (p. ej. Dracula) se dejan casi opacos; los vivos, translúcidos. */
export function selectionCss(selection: string, background: string): string {
  const [r, g, b] = rgb(selection);
  const [br, bg, bb] = rgb(background);
  const dist = Math.hypot(r - br, g - bg, b - bb) / 441.67;
  return `rgba(${r},${g},${b},${dist < 0.25 ? 0.85 : 0.3})`;
}

export function defToTermTheme(d: ThemeDef): TermTheme {
  const a = d.ansi;
  return {
    background: d.background, foreground: d.foreground, cursor: d.cursor, cursorAccent: d.background,
    selectionBackground: selectionCss(d.selection, d.background),
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

// Mismo contenido => mismo objeto: terminals.applyOptions compara por identidad y renombrar no debe repintar.
const termCache = new Map<string, TermTheme>();
function cachedTerm(d: ThemeDef): TermTheme {
  const key = [d.background, d.foreground, d.cursor, d.selection, ...d.ansi].join('|');
  let t = termCache.get(key);
  if (!t) {
    if (termCache.size > 200) termCache.clear();
    t = defToTermTheme(d);
    termCache.set(key, t);
  }
  return t;
}

/** Integrados primero, luego los propios (en el orden en que se guardaron). */
export function allThemes(custom: readonly ThemeDef[]): ThemeEntry[] {
  const out: ThemeEntry[] = THEME_IDS.map((id) => ({ id, label: THEMES[id].label, custom: false, theme: THEMES[id].theme }));
  for (const d of custom) out.push({ id: d.id, label: d.name, custom: true, theme: cachedTerm(d) });
  return out;
}

/** ¿Existe este tema (integrado o propio)? */
export function hasTheme(id: string, custom: readonly ThemeDef[]): boolean {
  return Object.hasOwn(THEMES, id) || custom.some((d) => d.id === id);
}

/** Tema de un id; si ya no existe (borrado, no cargable) cae en silencio a Orchestra Dark. */
export function resolveTheme(id: string, custom: readonly ThemeDef[]): TermTheme {
  if (Object.hasOwn(THEMES, id)) return (THEMES as Record<string, { theme: TermTheme }>)[id].theme;
  const d = isCustomThemeId(id) ? custom.find((c) => c.id === id) : undefined;
  return d ? cachedTerm(d) : THEMES[DEFAULT_THEME].theme;
}
