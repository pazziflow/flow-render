// Look „Skizzenbuch“: handgeschriebener Text (Gochi Hand), leicht schräg, ohne Schatten, in der freien Fläche neben/über der Figur.
// Erste Zeile groß (Einstieg wie „Montag.“), Rest kleiner; dazu eine kleine Kritzelei (Pfeil, Herz oder Kringel) Richtung Figur.
// Liefert t1.png (transparent, 1080×1920) – das Bild selbst wird nicht verkleinert.
import { AUFBAU, B, H } from './layout.mjs';

const FONT = 'https://fonts.googleapis.com/css2?family=Gochi+Hand&family=Poppins:wght@500&display=block';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Textfläche je Seite der Figur (Anteile von Breite/Höhe): Figur rechts → Text links, Figur links → Text rechts, Figur unten → Text oben
const FLAECHE = {
  rechts: { x: 0.07, y: 0.16, b: 0.50, h: 0.46, ausrichtung: 'left', kipp: -3 },
  links: { x: 0.50, y: 0.16, b: 0.44, h: 0.46, ausrichtung: 'left', kipp: 2.5 },
  unten: { x: 0.10, y: 0.13, b: 0.80, h: 0.24, ausrichtung: 'center', kipp: -2 },
};

/** Kritzelei als SVG: Pfeil zur Figur, Herz oder Kringel – fest je Text (gleicher Text = gleiche Kritzelei) */
function kritzelei(art, seite) {
  const strich = 'fill="none" stroke="#2B2622" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
  if (art === 0) {
    // geschwungener Pfeil Richtung Figur
    const spiegel = seite === 'links' ? 'transform="scale(-1,1) translate(-140,0)"' : '';
    return `<svg width="140" height="110" viewBox="0 0 140 110"><g ${spiegel}><path ${strich} d="M10 20 C 40 10, 70 30, 60 55 C 52 75, 30 60, 45 48 C 65 35, 95 60, 120 88"/><path ${strich} d="M104 86 L122 90 L118 72"/></g></svg>`;
  }
  if (art === 1) return `<svg width="90" height="80" viewBox="0 0 90 80"><path ${strich} d="M45 70 C 10 45, 8 18, 28 14 C 40 12, 45 24, 45 28 C 45 24, 52 11, 64 14 C 84 19, 78 46, 45 70 Z"/></svg>`;
  return `<svg width="110" height="70" viewBox="0 0 110 70"><path ${strich} d="M8 40 C 20 10, 40 60, 55 30 C 68 8, 80 55, 102 26"/></svg>`;
}

/** a: { text1, text2?, seite, handle?, marke? } → { t1, t2: null, skala: 1, farbe: null, modus: 'cover' } */
export async function skizzeTextBauen(browser, a, dir) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: B, height: H, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><link href="${FONT}" rel="stylesheet">
<style>html,body{margin:0;width:${B}px;height:${H}px;background:transparent;overflow:hidden}
.f{position:absolute;box-sizing:border-box;font-family:'Gochi Hand',cursive;color:${/^#[0-9A-Fa-f]{6}$/.test(a.schriftfarbe ?? '') ? a.schriftfarbe : '#2B2622'};white-space:pre-line;overflow-wrap:normal;word-break:keep-all;hyphens:none}
.k{font-size:1.32em;line-height:1.05;margin-bottom:.35em;display:block}
.r{line-height:1.18;display:block}
.d{position:absolute}
.handle{position:absolute;left:0;right:0;text-align:center;font-family:'Poppins',sans-serif;font-weight:500}</style></head>
<body><span style="font-family:'Gochi Hand'">.</span></body></html>`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

    const ganz = [String(a.text1 ?? '').trim(), String(a.text2 ?? '').trim()].filter(Boolean).join('\n');
    const zeilen = ganz.replace(/\\n/g, '\n').split('\n').map((z) => z.trim()).filter(Boolean);
    // Einstieg: erste Zeile, wenn kurz (bis 4 Wörter); sonst alles gleich groß
    const einstieg = zeilen.length > 1 && zeilen[0].split(/\s+/).length <= 4 ? zeilen[0] : '';
    const rest = (einstieg ? zeilen.slice(1) : zeilen).join('\n');
    const seite = FLAECHE[a.seite] ? a.seite : 'unten';
    const F = FLAECHE[seite];
    const art = [...ganz].reduce((x, c) => (x + c.charCodeAt(0)) % 3, 0);

    const pos = a.text_pos ?? {}; // vom Nutzer verschoben/vergrößert
    const html = `<div class="f" id="f" style="left:${F.x * B}px;top:${F.y * H}px;width:${F.b * B}px;text-align:${F.ausrichtung};transform:translate(${(Number(pos.dx ?? 0) / 100) * B}px, ${(Number(pos.dy ?? 0) / 100) * H}px) rotate(${F.kipp}deg) scale(${Number(pos.s ?? 1)});transform-origin:top left">`
      + (einstieg ? `<span class="k">${esc(einstieg)}</span>` : '') + `<span class="r">${esc(rest)}</span></div>`;
    // Größe: von groß nach klein, bis der Text in die Fläche passt
    const px = await page.evaluate((html, maxH, start) => {
      document.body.insertAdjacentHTML('beforeend', html);
      const el = document.getElementById('f');
      let p = start;
      // längstes Wort muss in eine Zeile passen (kein Umbruch mitten im Wort)
      const passt = () => el.scrollHeight <= maxH && [...el.querySelectorAll('span')].every((s) => s.scrollWidth <= el.clientWidth + 2) && el.scrollWidth <= el.clientWidth + 2;
      for (; p > 34; p -= 2) { el.style.fontSize = p + 'px'; if (passt()) break; }
      return p;
    }, html, F.h * H, 104);
    // Kritzelei unter den Text, Richtung Figur
    await page.evaluate((svg, seite) => {
      const el = document.getElementById('f'); const r = el.getBoundingClientRect();
      const d = document.createElement('div'); d.className = 'd'; d.innerHTML = svg;
      const x = seite === 'rechts' ? r.left + Math.min(r.width * 0.55, 330) : seite === 'links' ? r.left + 20 : r.left + r.width / 2 - 55;
      d.style.left = x + 'px'; d.style.top = (r.bottom + 14) + 'px';
      document.body.appendChild(d);
    }, kritzelei(art, seite), seite);
    if (!(a.marke === false && !a.handle)) {
      // Im Skizzenbuch steht @Name klein unter dem Text (unten steht die Figur mit Gegenständen)
      const y = await page.evaluate(() => { const d = document.querySelector('.d'); const r = (d ?? document.getElementById('f')).getBoundingClientRect(); return r.bottom + 22; });
      await page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h),
        `<div class="handle" style="top:${y}px;left:${F.x * B}px;right:auto;width:${F.b * B}px;text-align:${F.ausrichtung};font-size:${AUFBAU.handle.px}px;line-height:${AUFBAU.handle.zeile};color:${AUFBAU.handle.farbe};opacity:${AUFBAU.handle.deckkraft};white-space:pre">${esc([a.marke !== false ? '@' + AUFBAU.handle.marke : '', a.handle ? '@' + a.handle : ''].filter(Boolean).join('\n'))}</div>`);
    }
    const t1 = `${dir}/t1.png`;
    await page.screenshot({ path: t1, omitBackground: true, type: 'png' });
    return { t1, t2: null, skala: 1, farbe: null, modus: 'cover', px };
  } finally {
    await page.close();
  }
}
