// Textaufbau wie Pupazzomio – gleiche Regeln im Renderer (render/textflaeche.mjs) und in der App (app/src/layout.ts).
// Alle Maße in px bei 1080 × 1920; messen(text, px, gewicht) liefert die Breite einer Zeile.
//  kurz (< 18 Wörter): fett, Start 66 px, in 2er-Schritten kleiner bis die längste Zeile in 74 % passt (min. 40 px),
//                      Zeilen aus dem Spruch (\n), zu lange Zeilen zwischen Wörtern umbrechen (max. 5 Zeilen),
//                      Text mittig zwischen 13 % und 40 % der Höhe.
//  lang (ab 18 Wörtern): mittel, Start 50 px (min. 34 px), Umbruch auf 80 % der Breite, Absätze bleiben, Text oben ab 13 % (Instagram-Sicherheitszone).
// Szene → Pointe: Größe und Lage richten sich nach dem vollen Text, die Szene allein steht an derselben Stelle.

export const B = 1080, H = 1920;
export const AUFBAU = {
  grenzeWoerter: 18,
  kurz: { start: 66, min: 40, schritt: 2, breite: 0.74, oben: 0.13, unten: 0.40, untenFigur: 0.42, zeile: 1.22, maxZeilen: 5 },
  lang: { start: 50, min: 34, schritt: 2, breite: 0.80, oben: 0.13, unten: 0.44, untenFigur: 0.44, zeile: 1.32 }, // oben 13 %: Instagram-Leiste + 3:4-Profilraster
  // Platz über der Figur: Text endet mind. 3 % über dem Kopf; reicht das nicht, wird das Bild kleiner (unten verankert, min. 72 %)
  // Messbare Figur (einfarbiger Hintergrund): Text sitzt unten auf, kurz über dem Kopf (höchstens bis untenFigur), statt mittig weit oben.
  // Reicht der Platz nicht, rutscht er nach oben (bis 13 %), wird kleiner und zuletzt das Bild kleiner.
  figur: { abstand: 0.03, textLuft: 0.06, minUnten: 0.30, minSkala: 0.72, messBreite: 120 },
  // Branding unter der Figur: @pazziflow und darunter @Account, klein und halbtransparent (wie bei Meme-Accounts)
  handle: { px: 34, y: 0.872, zeile: 1.3, farbe: '#8A735F', deckkraft: 0.55, marke: 'pazziflow' },
};

const woerter = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;

/** Wörter einer Zeile auf maxBreite umbrechen */
function umbrechen(zeile, px, gewicht, maxBreite, messen) {
  const w = zeile.split(/\s+/).filter(Boolean);
  if (!w.length) return [''];
  const aus = [];
  let akt = w[0];
  for (const x of w.slice(1)) {
    if (messen(`${akt} ${x}`, px, gewicht) <= maxBreite) akt = `${akt} ${x}`;
    else { aus.push(akt); akt = x; }
  }
  aus.push(akt);
  return aus;
}

/** Wo beginnt die Figur? Bilder haben einen einfarbigen Hintergrund: erste Zeile von oben, die sich deutlich davon abhebt.
 *  pixel = RGBA eines verkleinerten Bildes (b × h). Liefert frei (0..1 = Anteil der Höhe über der Figur) und die Hintergrundfarbe. */
export function figurOben(pixel, b, h) {
  const p = (x, y) => (y * b + x) * 4;
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = 0; y < 3; y++) for (let x = 0; x < b; x++) { const i = p(x, y); r += pixel[i]; g += pixel[i + 1]; bl += pixel[i + 2]; n++; }
  r /= n; g /= n; bl /= n;
  // Einfarbig? (mittlere Abweichung der obersten Zeilen klein) – sonst ist die Messung nicht verlässlich
  let abw = 0;
  for (let y = 0; y < 3; y++) for (let x = 0; x < b; x++) { const i = p(x, y); abw += Math.abs(pixel[i] - r) + Math.abs(pixel[i + 1] - g) + Math.abs(pixel[i + 2] - bl); }
  const einheitlich = abw / n < 18;
  let frei = 1;
  for (let y = 3; y < h; y++) {
    let anders = 0;
    for (let x = 0; x < b; x++) { const i = p(x, y); if (Math.abs(pixel[i] - r) + Math.abs(pixel[i + 1] - g) + Math.abs(pixel[i + 2] - bl) > 60) anders++; }
    if (anders > b * 0.02) { frei = y / h; break; }
  }
  return { frei, einheitlich, farbe: `rgb(${Math.round(r)},${Math.round(g)},${Math.round(bl)})` };
}

/** Wie das Bild ins Hochformat kommt: 9:16-Bilder füllen (cover); breitere Bilder mit einfarbigem Hintergrund (z. B. das
 *  quadratische Hauptbild) stehen in voller Breite unten, oben wird mit der Hintergrundfarbe aufgefüllt.
 *  Liefert frei (Anteil der Reel-Höhe über der Figur; 1 = unbekannt) und den Modus. */
export function bildAufbau(m, iw, ih) {
  const seite = iw / ih, ziel = B / H;
  if (!m.einheitlich) return { modus: 'cover', frei: 1 };
  if (seite > ziel * 1.05) {
    const hoehe = (B * ih / iw) / H;
    return { modus: 'unten', frei: 1 - hoehe * (1 - m.frei) };
  }
  const sichtbar = Math.min(1, seite / ziel);
  return { modus: 'cover', frei: Math.max(0, (m.frei - (1 - sichtbar) / 2) / sichtbar) };
}

/**
 * @returns {{ px: number, gewicht: number, zeile: number, top: number, skala: number, zeilen1: string[], zeilen: string[], art: 'kurz'|'lang' }}
 * zeilen1 = nur Szene, zeilen = Szene + Leerzeile + Pointe (gleiche Größe, gleiche Oberkante)
 */
export function textAufbau(text1, text2, schrift, messen, frei = 1) {
  const t1 = String(text1 ?? '').replace(/\\n/g, '\n').trim();
  const t2 = String(text2 ?? '').replace(/\\n/g, '\n').trim();
  const n = woerter(t1) + woerter(t2);
  const kurz = n < AUFBAU.grenzeWoerter;
  const A = kurz ? AUFBAU.kurz : AUFBAU.lang;
  const gewicht = kurz ? schrift.kurz : schrift.lang;
  const maxB = A.breite * B;
  const absaetze = (t) => t.split('\n');
  const bauen = (px) => {
    const z1 = absaetze(t1).flatMap((z) => (kurz && messen(z, px, gewicht) <= maxB) ? [z] : umbrechen(z, px, gewicht, maxB, messen));
    const z2 = t2 ? absaetze(t2).flatMap((z) => (kurz && messen(z, px, gewicht) <= maxB) ? [z] : umbrechen(z, px, gewicht, maxB, messen)) : [];
    return { z1, alle: t2 ? [...z1, '', ...z2] : z1 };
  };
  // Unterkante: Standard, aber nicht in die Figur hinein (frei = 1: Bild nicht messbar → Standard)
  const F = AUFBAU.figur;
  const messbar = frei < 1;
  const unten = messbar ? Math.max(Math.min(A.untenFigur, frei - F.textLuft), F.minUnten) : A.unten;
  const raum = (unten - A.oben) * H;
  let px = A.start, z = bauen(px);
  for (;;) {
    const breiteste = Math.max(...z.alle.map((x) => messen(x, px, gewicht)));
    const hoehe = z.alle.length * px * A.zeile;
    const zuViel = kurz ? (breiteste > maxB || z.alle.filter(Boolean).length > A.maxZeilen || hoehe > raum) : hoehe > raum;
    if (!zuViel || px <= A.min) break;
    px = Math.max(A.min, px - A.schritt);
    z = bauen(px);
  }
  const hoehe = z.alle.length * px * A.zeile;
  const top = messbar ? Math.max(A.oben * H, unten * H - hoehe)
    : kurz ? Math.max(A.oben * H, ((A.oben + unten) / 2) * H - hoehe / 2) : A.oben * H;
  // Reicht der Platz trotzdem nicht: Bild unten verankert verkleinern, bis der Kopf unter dem Text liegt
  const textUnten = top + hoehe + F.abstand * H;
  const skala = messbar && textUnten > frei * H ? Math.max(F.minSkala, Math.min(1, (H - textUnten) / (H - frei * H))) : 1;
  return { px, gewicht, zeile: A.zeile, top, skala, zeilen1: z.z1, zeilen: z.alle, art: kurz ? 'kurz' : 'lang' };
}
