// Runner der Meme Fabrik: holt Aufträge, führt sie aus, meldet Ergebnisse.
// Gibt bewusst keine Inhalte (Texte, Namen) aus – die Logs dieses öffentlichen Repos zeigen nur IDs.
import puppeteer from 'puppeteer-core';
import { kiAusfuehren } from './ki.mjs';
import { reelBauen } from './render.mjs';
import { bildBauen } from './bild.mjs';
import { bildTaggen } from './vertex.mjs';
import { batchStarten, batchHolen } from './batch.mjs';

const URL = process.env.FLOW_FABRIK_URL;
const SCHLUESSEL = process.env.FLOW_RUNNER_SCHLUESSEL;
const PARALLEL = Number(process.env.FLOW_PARALLEL ?? 4);
const MAX_LAUFZEIT = 30 * 60 * 1000;
const LEER_WARTEN = 5000;
// Vorgewärmt (noch nichts zu tun): bis zu 6 Minuten bereit bleiben; nach getaner Arbeit: 60 s auf weitere Aufträge warten
// Ein Arbeiter hört erst auf, wenn ALLE nichts mehr zu tun haben (sonst bleibt bei langen Aufträgen nur einer übrig)
const LEER_START_MS = 6 * 60 * 1000, LEER_MS = 60 * 1000;
let schonGearbeitet = false, beschaeftigt = 0, letzteArbeit = Date.now();

if (!URL || !SCHLUESSEL) { console.error('FLOW_FABRIK_URL / FLOW_RUNNER_SCHLUESSEL fehlen'); process.exit(1); }

async function api(body) {
  for (let v = 1; v <= 3; v++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-flow-runner': SCHLUESSEL }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.fehler ?? `HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (v === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * v));
    }
  }
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
let browserP; // ein gemeinsamer Browser für alle Arbeiter

async function arbeiter(nr) {
  while (Date.now() - start < MAX_LAUFZEIT) {
    const { auftrag } = await api({ aktion: 'runner_naechster' });
    if (!auftrag) {
      if (beschaeftigt === 0 && Date.now() - letzteArbeit > (schonGearbeitet ? LEER_MS : LEER_START_MS)) return;
      await schlaf(LEER_WARTEN);
      continue;
    }
    schonGearbeitet = true;
    letzteArbeit = Date.now();
    if (auftrag.art === 'uebersprungen') continue;
    beschaeftigt++;
    const t0 = Date.now();
    try {
      if (auftrag.art === 'ki') {
        const e = await kiAusfuehren(auftrag.ki);
        await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: true, daten: e.daten, nutzung: e.nutzung });
      } else if (auftrag.art === 'render') {
        browserP ??= puppeteer.launch({ executablePath: process.env.CHROME_PFAD ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none'] });
        const d = await reelBauen(await browserP, auftrag.render);
        await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: true, daten: d });
      } else if (auftrag.art === 'bild') {
        const d = await bildBauen(auftrag.bild);
        await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: true, daten: d });
      } else if (auftrag.art === 'taggen') {
        // Schlagworte für ältere Bilder nachtragen (günstiges Prüfmodell, ein Aufruf je Bild)
        const tags = {};
        for (const b of auftrag.taggen.bilder) {
          try { tags[b.id] = await bildTaggen({ url: b.url, modell: auftrag.taggen.modell, ort: auftrag.taggen.ort }); } catch { /* nächstes Bild */ }
        }
        await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: true, daten: { tags } });
      } else if (auftrag.art === 'bild_batch') {
        const d = auftrag.batch.job ? await batchHolen(auftrag.batch) : await batchStarten(auftrag.batch);
        await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: true, daten: d });
      }
      console.log(`[${nr}] ${auftrag.art} ${auftrag.id.slice(0, 8)} ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      console.log(`[${nr}] ${auftrag.art} ${auftrag.id.slice(0, 8)} Fehler`);
      await api({ aktion: 'runner_ergebnis', id: auftrag.id, ok: false, fehler: String(e?.message ?? e).slice(0, 500) }).catch(() => {});
    }
    beschaeftigt--;
    letzteArbeit = Date.now();
  }
}

try {
  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => arbeiter(i + 1)));
} finally {
  if (browserP) await (await browserP).close().catch(() => {});
  await api({ aktion: 'runner_ende' }).catch(() => {});
  console.log(`Fertig nach ${((Date.now() - start) / 1000).toFixed(0)} s`);
}
