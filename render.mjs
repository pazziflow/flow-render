// Reel bauen: Figurenbild mit Zoom hin und zurück (nahtloser Loop), Szene → Szene + Pointe, Musik ab Sekunde 0.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textflaechenBauen } from './textflaeche.mjs';
import { skizzeTextBauen } from './skizze.mjs';

const ausfuehren = promisify(execFile);

async function laden(url, ziel) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  await writeFile(ziel, Buffer.from(await r.arrayBuffer()));
}

async function hochladen(signedUrl, datei, typ) {
  const r = await fetch(signedUrl, { method: 'PUT', headers: { 'Content-Type': typ, 'x-upsert': 'true' }, body: await readFile(datei) });
  if (!r.ok) throw new Error(`Upload fehlgeschlagen (${r.status})`);
}

export async function reelBauen(browser, a) {
  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  try {
    const R = a.reel;
    const B = R.breite, H = R.hoehe, fps = R.fps, L = R.laenge_s;
    const frames = Math.round(L * fps);
    const zmax = R.zoom_max;

    await laden(a.bild_url, join(dir, 'bild.jpg'));
    if (a.musik_url) await laden(a.musik_url, join(dir, 'musik'));

    // Szene (text1) steht von Anfang an; ab wechsel_s kommt die Pointe (text2) darunter dazu
    const skizze = a.look === 'skizze';
    const t2 = skizze ? '' : (a.text2 ?? '').trim(); // Skizzenbuch: ganzer Text von Anfang an
    const wechsel = t2 ? Math.min(Math.max(a.wechsel_s || 3, 1), L - 1) : L;
    // Textaufbau wie Pupazzomio: Größe/Lage aus dem vollen Text, Szene allein an derselben Stelle
    const schrift = a.schrift ?? { familie: 'Poppins', kurz: 700, lang: 500 };
    // Skizzenbuch: Figur gespiegelt → steht auf der anderen Seite, Text wandert mit
    const seite = a.spiegeln && a.seite !== 'unten' ? (a.seite === 'rechts' ? 'links' : 'rechts') : a.seite;
    const tf = skizze
      ? await skizzeTextBauen(browser, { text1: a.text1, text2: a.text2, seite, handle: a.handle ?? null, marke: a.marke }, dir)
      : await textflaechenBauen(browser, { text1: a.text1, text2: t2, stil: a.stil, schrift, handle: a.handle ?? null, marke: a.marke, bild: join(dir, 'bild.jpg') }, dir);
    // Platz für den Text: Bild unten verankert verkleinern, oben mit der Hintergrundfarbe des Bildes auffüllen
    const hex = (rgb) => { const m = String(rgb ?? '').match(/\d+/g); return m ? '0x' + m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : '0xEDE8DF'; };
    const sk = Math.min(1, Math.max(0.5, Number(tf.skala ?? 1)));
    const schieben = sk < 0.999 ? `scale=${Math.round(B * 2 * sk / 2) * 2}:${Math.round(H * 2 * sk / 2) * 2},pad=${B * 2}:${H * 2}:(ow-iw)/2:oh-ih:color=${hex(tf.farbe)},` : '';
    // Breite Bilder (z. B. quadratisches Hauptbild): volle Breite unten, oben Hintergrundfarbe – statt hochzuzoomen
    const einpassen = tf.modus === 'unten'
      ? `scale=${B * 2}:-2,pad=${B * 2}:${H * 2}:0:oh-ih:color=${hex(tf.farbe)},`
      : `scale=${B * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${B * 2}:${H * 2},`;

    const args = ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', String(fps), '-i', join(dir, 'bild.jpg'), '-loop', '1', '-i', join(dir, 't1.png')];
    if (t2) args.push('-loop', '1', '-i', join(dir, 't2.png'));
    const audioIdx = t2 ? 3 : 2;
    if (a.musik_url) args.push('-ss', String(a.musik_start || 0), '-t', String(L), '-i', join(dir, 'musik'));
    else args.push('-f', 'lavfi', '-t', String(L), '-i', 'anullsrc=r=44100:cl=stereo');

    // Zoom: weich hinein bis zur Hälfte der Laufzeit, dann zurück → erstes = letztes Bild (Loop)
    // zoom_raus: beginnt nah und fährt erst heraus (Abwechslung bei wiederholten Bildern)
    const welle = `(1-cos(2*PI*on/${frames}))/2`;
    const my = Number(R.zoom_mitte_y ?? 0.5).toFixed(3); // Zoom-Mitte auf Höhe der Figur
    const z = a.zoom_raus ? `${zmax.toFixed(4)}-${(zmax - 1).toFixed(4)}*${welle}` : `1+${(zmax - 1).toFixed(4)}*${welle}`;
    let f = `[0:v]${a.spiegeln ? 'hflip,' : ''}${einpassen}${schieben}` +
      `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='${my}*ih-(ih/zoom*${my})':d=1:s=${B}x${H}:fps=${fps},setsar=1[bg];` +
      // Ohne Pointe bleibt der Text bis zum letzten Bild (enable mit t < Länge schaltete das letzte Bild ab)
      `[bg][1:v]overlay=0:0${t2 ? `:enable='lt(t,${wechsel})'` : ''}[v1]`;
    if (t2) f += `;[v1][2:v]overlay=0:0:enable='gte(t,${wechsel})'[v]`;
    else f += `;[v1]null[v]`;
    f += `;[${audioIdx}:a]afade=t=in:st=0:d=0.05,afade=t=out:st=${(L - R.ausblenden_s).toFixed(2)}:d=${R.ausblenden_s},apad[a]`;

    const mp4 = join(dir, 'reel.mp4');
    args.push('-filter_complex', f, '-map', '[v]', '-map', '[a]', '-t', String(L), '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-movflags', '+faststart', mp4);
    await ausfuehren('ffmpeg', args, { maxBuffer: 1 << 24 });

    const jpg = join(dir, 'vorschau.jpg');
    await ausfuehren('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', mp4, '-frames:v', '1', '-vf', 'scale=540:960', '-q:v', '3', jpg]);

    await hochladen(a.upload.mp4.signedUrl, mp4, 'video/mp4');
    await hochladen(a.upload.jpg.signedUrl, jpg, 'image/jpeg');
    return { mp4: a.upload.mp4.pfad, jpg: a.upload.jpg.pfad };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
