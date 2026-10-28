// Bilder im Batch (TEXTE-BILDER-PLAN 7.): halber Preis, Ergebnis nach Minuten bis Stunden.
// Ablauf: start → JSONL nach Google Cloud Storage, Batch-Auftrag anlegen. holen → Stand abfragen, fertige Bilder prüfen und hochladen.
// Braucht einen GCS-Bucket, auf den das Dienstkonto schreiben darf (regelwerk bilder_bedarf.batch_bucket). Schalter: bilder_bedarf.batch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zugang, bildTeil, bildPruefen } from './vertex.mjs';

const run = promisify(execFile);
const MASSE = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };

async function google(url, init = {}) {
  const z = await zugang();
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${z.wert}`, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

/** a: { bucket, ort, modell, eintraege: [{ id, prompt, vorlagen_urls, format }] } → { job, praefix } */
export async function batchStarten(a) {
  const z = await zugang();
  const zeilen = [];
  for (const e of a.eintraege) {
    const vorlagen = await Promise.all(e.vorlagen_urls.map(bildTeil));
    zeilen.push(JSON.stringify({ request: {
      contents: [{ role: 'user', parts: [...vorlagen, { text: e.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: e.format ?? '9:16' } },
    } }));
  }
  const name = `batch/${Date.now()}`;
  await google(`https://storage.googleapis.com/upload/storage/v1/b/${a.bucket}/o?uploadType=media&name=${encodeURIComponent(`${name}/ein.jsonl`)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/jsonl' }, body: zeilen.join('\n') });
  const ort = a.ort === 'global' ? 'us-central1' : a.ort;
  const r = await google(`https://${ort}-aiplatform.googleapis.com/v1/projects/${z.projekt}/locations/${ort}/batchPredictionJobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: `flow-${Date.now()}`, model: `publishers/google/models/${a.modell}`,
      inputConfig: { instancesFormat: 'jsonl', gcsSource: { uris: [`gs://${a.bucket}/${name}/ein.jsonl`] } },
      outputConfig: { predictionsFormat: 'jsonl', gcsDestination: { outputUriPrefix: `gs://${a.bucket}/${name}/aus/` } },
    }),
  });
  const j = await r.json();
  return { job: j.name, praefix: `${name}/aus/` };
}

/** a: { job, bucket, praefix, pruef_modell, ort, eintraege: [{ id, prompt, szene_text, pruef_modus, pruef_vorlage_url, format, upload }] } */
export async function batchHolen(a) {
  const ort = a.job.split('/locations/')[1].split('/')[0];
  const job = await (await google(`https://${ort}-aiplatform.googleapis.com/v1/${a.job}`)).json();
  if (['JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED'].includes(job.state)) return { fertig: true, fehler: job.state, ergebnisse: [] };
  if (job.state !== 'JOB_STATE_SUCCEEDED') return { fertig: false, stand: job.state };

  // Ausgabedateien lesen und Antworten den Einträgen zuordnen (über den Prompt-Text)
  const liste = await (await google(`https://storage.googleapis.com/storage/v1/b/${a.bucket}/o?prefix=${encodeURIComponent(a.praefix)}`)).json();
  const bilder = new Map();
  for (const o of liste.items ?? []) {
    if (!o.name.endsWith('.jsonl')) continue;
    const text = await (await google(`https://storage.googleapis.com/storage/v1/b/${a.bucket}/o/${encodeURIComponent(o.name)}?alt=media`)).text();
    for (const zeile of text.split('\n').filter(Boolean)) {
      const d = JSON.parse(zeile);
      const prompt = (d.request?.contents?.[0]?.parts ?? []).map((p) => p.text).filter(Boolean).pop();
      const teil = (d.response?.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
      if (prompt && teil) bilder.set(prompt, Buffer.from(teil.inlineData.data, 'base64'));
    }
  }

  const ergebnisse = [];
  for (const e of a.eintraege) {
    const roh = bilder.get(e.prompt);
    if (!roh) { ergebnisse.push({ id: e.id, ok: false, protokoll: [{ versuch: 1, erzeugt: false, grund: 'kein Bild im Batch' }] }); continue; }
    const vorlage = await bildTeil(e.pruef_vorlage_url);
    const p = await bildPruefen({ bild: roh, vorlage, szene: e.szene_text, modell: a.pruef_modell, ort: a.ort, modus: e.pruef_modus ?? 'szene', einfarbig: !!e.einfarbig })
      .catch((x) => ({ ok: false, grund: `Prüfung fehlgeschlagen: ${String(x?.message ?? x).slice(0, 150)}` }));
    const protokoll = [{ versuch: 1, erzeugt: true, batch: true, ok: !!p.ok, grund: p.grund ?? '' }];
    if (!p.ok) { ergebnisse.push({ id: e.id, ok: false, protokoll }); continue; }
    const ordner = await mkdtemp(join(tmpdir(), 'batch-'));
    try {
      const ein = join(ordner, 'roh.png'), gross = join(ordner, 'bild.webp'), klein = join(ordner, 'klein.webp');
      await writeFile(ein, roh);
      const [bw, bh] = MASSE[e.format ?? '9:16'] ?? MASSE['9:16'];
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', ein, '-vf', `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh}`, '-c:v', 'libwebp', '-quality', '86', gross]);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', gross, '-vf', 'scale=360:-2', '-c:v', 'libwebp', '-quality', '80', klein]);
      for (const [datei, ziel] of [[gross, e.upload.bild], [klein, e.upload.klein]]) {
        const r = await fetch(ziel.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/webp', 'x-upsert': 'true' }, body: await readFile(datei) });
        if (!r.ok) throw new Error(`Upload ${r.status}`);
      }
      ergebnisse.push({ id: e.id, ok: true, bild: e.upload.bild.pfad, klein: e.upload.klein.pfad, protokoll, tags: p.tags ?? null });
    } finally {
      await rm(ordner, { recursive: true, force: true });
    }
  }
  return { fertig: true, ergebnisse };
}
