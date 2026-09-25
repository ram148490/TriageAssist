/**
 * Static WCAG colour-contrast check for the UI. There is no browser here, so instead of
 * measuring pixels we read the class lists out of src/**\/*.ts(x), resolve each Tailwind
 * colour to sRGB using Tailwind's own palette (node_modules/tailwindcss/theme.css, which is
 * defined in OKLCH), and check every text-on-background pair against WCAG AA:
 *
 *   - text needs 4.5:1 (all text here is under the "large text" size)
 *   - the boundary of a form field needs 3:1 (WCAG 1.4.11): it is the only thing that
 *     shows where the field is
 *   - placeholder text needs 4.5:1
 *
 * It looks at pairs declared in the same class string (plus hover: variants). Text with no
 * background of its own is checked against white and against the page background
 * (slate-50). It can't see colours inherited from a differently-coloured ancestor, so a
 * new coloured container needs a bg-* on the same element as its text to be covered.
 *
 *   npm run test:a11y
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

// ---------------------------------------------------------------- palette
const theme = fs.readFileSync(path.join('node_modules', 'tailwindcss', 'theme.css'), 'utf8');
const palette = new Map<string, [number, number, number]>([
  ['white', [1, 1, 1]],
  ['black', [0, 0, 0]],
]);

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return lin.map(gamma) as [number, number, number];
}

for (const m of theme.matchAll(/--color-([a-z]+-\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)) {
  palette.set(m[1], oklchToSrgb(Number(m[2]) / 100, Number(m[3]), Number(m[4])));
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export function contrast(fg: string, bg: string): number {
  const f = palette.get(fg);
  const b = palette.get(bg);
  if (!f || !b) throw new Error(`unknown colour: ${!f ? fg : bg}`);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Sanity-check the converter against colours whose contrast is well known.
assert.ok(Math.abs(contrast('black', 'white') - 21) < 0.01, 'black on white is 21:1');
assert.ok(contrast('slate-400', 'white') < 3, 'slate-400 on white is a known failure');
assert.ok(contrast('slate-700', 'white') > 8, 'slate-700 on white is comfortably accessible');

// ---------------------------------------------------------------- scan
const files: string[] = [];
(function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) files.push(p);
  }
})('src');

interface Finding {
  where: string;
  what: string;
  ratio: number;
  need: number;
}
const checked: Finding[] = [];
const PAGE_BG = 'slate-50';

const colourOf = (token: string | undefined, prefix: 'text' | 'bg' | 'border') => {
  const m = token?.match(new RegExp(`^${prefix}-((?:white|black)|(?:[a-z]+-\\d+))$`));
  return m ? m[1] : undefined;
};

/** Every string literal (and the static parts of template literals) in a file, via the real parser. */
function stringLiterals(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  (function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  })(source);
  return out;
}

for (const file of files) {
  for (const text of stringLiterals(file)) {
    if (!/(text|bg|border|placeholder)-/.test(text) || text.length > 600) continue;
    const tokens = text.split(/\s+/).filter(Boolean);
    const where = `${file}: "${text.length > 70 ? `${text.slice(0, 67)}...` : text}"`;
    // A sized svg with no padding is an icon: non-text content needs 3:1, not 4.5:1.
    const isIcon = tokens.some((t) => /^h-\d/.test(t)) && tokens.some((t) => /^w-\d/.test(t)) && !tokens.some((t) => /^p[xy]?-/.test(t));

    for (const variant of ['', 'hover:']) {
      // The first token that is actually a colour (text-sm / text-xs are sizes, not colours).
      const firstColour = (prefix: 'text' | 'bg', v: string) =>
        tokens
          .filter((t) => t.startsWith(`${v}${prefix}-`))
          .map((t) => colourOf(t.slice(v.length), prefix))
          .find(Boolean);
      const pick = (prefix: 'text' | 'bg') => firstColour(prefix, variant) ?? (variant ? firstColour(prefix, '') : undefined);
      const fg = pick('text');
      const bg = pick('bg');
      if (!fg || (variant && !tokens.some((t) => t.startsWith(variant)))) continue;
      if (fg === 'white' && !bg) continue; // white text with no bg of its own (e.g. inside a coloured button)
      const grounds = bg ? [bg] : ['white', PAGE_BG];
      for (const ground of grounds) {
        if (variant === 'hover:' && !tokens.some((t) => t.startsWith('hover:bg-') || t.startsWith('hover:text-'))) continue;
        checked.push({
          where: `${where}${variant ? ' [hover]' : ''}`,
          what: `${isIcon ? 'icon' : 'text'}-${fg} on ${bg ? 'bg' : 'page'}-${ground}`,
          ratio: contrast(fg, ground),
          need: isIcon ? 3 : 4.5,
        });
      }
    }

    // Form-field boundary (border on a bordered, full-width, non-button control): 3:1.
    const border = colourOf(tokens.find((t) => t.startsWith('border-') && !t.includes(':')), 'border');
    const isField =
      tokens.includes('w-full') && tokens.includes('rounded-md') && tokens.includes('border') &&
      !tokens.some((t) => /^(font-|bg-)/.test(t)) && tokens.some((t) => /^py-/.test(t));
    if (isField && border) {
      checked.push({ where, what: `field border-${border} on white`, ratio: contrast(border, 'white'), need: 3 });
      const placeholder = colourOf(tokens.find((t) => t.startsWith('placeholder:text-'))?.slice('placeholder:'.length), 'text');
      checked.push({
        where,
        what: placeholder ? `placeholder-${placeholder} on white` : 'placeholder colour (none set: the browser default is too faint)',
        ratio: placeholder ? contrast(placeholder, 'white') : 0,
        need: 4.5,
      });
    }
  }
}

// ---------------------------------------------------------------- report
const failures = checked.filter((c) => c.ratio + 1e-9 < c.need);
const seen = new Set<string>();
console.log(`Checked ${checked.length} colour pairs in ${files.length} files.`);
for (const f of failures) {
  const key = `${f.where}|${f.what}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  FAIL ${f.ratio.toFixed(2)}:1 (needs ${f.need}:1)  ${f.what}\n       ${f.where}`);
}

if (failures.length) {
  console.error(`\ntest-a11y-contrast: ${seen.size} failing pair(s).`);
  process.exit(1);
}
const lowest = [...checked].sort((a, b) => a.ratio / a.need - b.ratio / b.need).slice(0, 3);
console.log(`Tightest passing pairs: ${lowest.map((l) => `${l.ratio.toFixed(2)}:1 ${l.what}`).join('; ')}`);
console.log('test-a11y-contrast: all colour pairs meet WCAG AA.');
