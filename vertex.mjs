// Google Vertex AI: Anmeldung mit Dienstkonto (GitHub-Secret FLOW_VERTEX_KEY), Bild erzeugen, Bild prüfen.
// Gibt keine Inhalte aus (öffentliches Repo).
import { createSign } from 'node:crypto';

let token = null;

export async function zugang() {
  if (token && token.bis > Date.now() + 60000) return token;
  const roh = process.env.FLOW_VERTEX_KEY;
  if (!roh) throw new Error('FLOW_VERTEX_KEY fehlt (Google-Zugang noch nicht eingerichtet)');
  const k = JSON.parse(roh);
  const jetzt = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const kopf = b64({ alg: 'RS256', typ: 'JWT' });
  const inhalt = b64({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: jetzt, exp: jetzt + 3600 });
  const sig = createSign('RSA-SHA256').update(`${kopf}.${inhalt}`).sign(k.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${kopf}.${inhalt}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google-Anmeldung: ${j.error_description ?? j.error ?? r.status}`);
  token = { wert: j.access_token, projekt: k.project_id, bis: Date.now() + j.expires_in * 1000 };
  return token;
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

async function aufruf(modell, ort, body) {
  const z = await zugang();
  const host = ort === 'global' ? 'aiplatform.googleapis.com' : `${ort}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${z.projekt}/locations/${ort}/publishers/google/models/${modell}:generateContent`;
  let letzte = '';
  for (let v = 0; v < 5; v++) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${z.wert}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    letzte = `Vertex HTTP ${r.status}: ${j.error?.message ?? ''}`.slice(0, 300);
    if (r.status !== 429 && r.status < 500) break;
    await schlaf(10000 * (v + 1)); // Google bremst: warten und erneut
  }
  throw new Error(letzte);
}

/** Bild als inlineData-Teil aus einer (signierten) URL */
export async function bildTeil(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Vorlage: HTTP ${r.status}`);
  const typ = r.headers.get('content-type')?.split(';')[0] || (/\.png(\?|$)/i.test(url) ? 'image/png' : /\.webp(\?|$)/i.test(url) ? 'image/webp' : 'image/jpeg');
  return { inlineData: { mimeType: typ, data: Buffer.from(await r.arrayBuffer()).toString('base64') } };
}

/** Neues Bild: Vorlagen (Hauptbild …) + Prompt → PNG-Buffer */
export async function bildErzeugen({ prompt, vorlagen, modell, ort = 'global', format = '9:16' }) {
  const teile = [...vorlagen, { text: prompt }];
  const j = await aufruf(modell, ort, {
    contents: [{ role: 'user', parts: teile }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: format } },
  });
  const antwort = j.candidates?.[0]?.content?.parts ?? [];
  const teil = teiler(antwort);
  if (!teil) {
    // Grund mitgeben (Blockade, Abbruchgrund, Text des Modells), damit Ablehnungen nachvollziehbar sind
    const grund = [j.promptFeedback?.blockReason && `block=${j.promptFeedback.blockReason}`, j.candidates?.[0]?.finishReason && `finish=${j.candidates[0].finishReason}`,
      antwort.map((p) => p.text ?? '').join(' ').trim().slice(0, 160)].filter(Boolean).join(' · ');
    throw new Error(`kein Bild in der Antwort${grund ? ` (${grund})` : ''}`);
  }
  return Buffer.from(teil.inlineData.data, 'base64');
}

const teiler = (teile) => teile.find((p) => p.inlineData?.data);

/** Bildprüfung mit einem günstigen Modell: gleiche Figur? Schrift? abgeschnitten? oberes Drittel frei? Szene passt? */
// Schlagworte je Bild (für die günstige Wiederverwendung): feste Listen, damit Bilder und Wünsche vergleichbar bleiben
export const TAG_LISTEN = {
  ort: ['büro', 'zuhause', 'küche', 'schlafzimmer', 'bad', 'café', 'restaurant', 'supermarkt', 'schule', 'straße', 'auto', 'natur', 'strand', 'fitness', 'neutral'],
  stimmung: ['müde', 'genervt', 'gestresst', 'fröhlich', 'entspannt', 'traurig', 'stolz', 'verliebt', 'motiviert', 'gelangweilt', 'überrascht', 'verwirrt', 'erschöpft', 'skeptisch', 'hungrig', 'verlegen', 'wütend', 'frech'],
  blick: ['zum_betrachter', 'zur_seite', 'nach_unten', 'nach_oben', 'augen_zu'],
  pose: ['stehen', 'sitzen', 'liegen', 'gehen', 'rennen', 'arme_verschraenkt', 'haende_hoch', 'zeigen', 'strecken', 'tanzen'],
  tageszeit: ['morgen', 'tag', 'abend', 'nacht'],
  ausschnitt: ['ganz', 'halb', 'nah'],
};
const TAG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ort: { type: 'STRING', enum: TAG_LISTEN.ort }, stimmung: { type: 'STRING', enum: TAG_LISTEN.stimmung },
    blick: { type: 'STRING', enum: TAG_LISTEN.blick }, pose: { type: 'STRING', enum: TAG_LISTEN.pose },
    tageszeit: { type: 'STRING', enum: TAG_LISTEN.tageszeit }, ausschnitt: { type: 'STRING', enum: TAG_LISTEN.ausschnitt },
    gegenstaende: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['ort', 'stimmung', 'blick', 'pose', 'tageszeit', 'ausschnitt', 'gegenstaende'],
};
const TAG_TEXT = 'Beschreibe außerdem in tags, was auf Bild 2 zu sehen ist: ort (neutral = einfarbiger oder leerer Hintergrund), stimmung der Figur, blick, pose, tageszeit, ausschnitt und gegenstaende (bis zu 4 deutlich sichtbare Dinge, keine Kleidung und keine Möbel, als einzelne deutsche Hauptwörter in der Einzahl, klein geschrieben, z. B. tasse, handy, laptop, buch, kissen; leer, wenn keine).';

/** Nur Schlagworte für ein vorhandenes Bild (Nachtragen für ältere Bilder) */
export async function bildTaggen({ url, modell, ort = 'global' }) {
  const j = await aufruf(modell, ort, {
    contents: [{ role: 'user', parts: [await bildTeil(url), { text: TAG_TEXT.replace('außerdem ', '').replaceAll('Bild 2', 'dem Bild') + ' Antworte nur als JSON.' }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { tags: TAG_SCHEMA }, required: ['tags'] } },
  });
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return JSON.parse(text).tags;
}

export async function bildPruefen({ bild, vorlage, szene, modell, ort = 'global', modus = 'szene', einfarbig = false }) {
  const mitTags = modus === 'szene' || modus === 'figur';
  const j = await aufruf(modell, ort, {
    contents: [{ role: 'user', parts: [
      { text: 'Bild 1 ist die Vorlage der Figur, Bild 2 das neue Bild.' }, vorlage,
      { inlineData: { mimeType: 'image/png', data: bild.toString('base64') } },
      { text: modus === 'selbst'
        // „Du als Figur“: Bild 1 ist ein Foto, Bild 2 soll eine gezeichnete 2D-Figur dieser Person sein
        ? 'Bild 1 ist ein Foto einer Person, Bild 2 soll eine gezeichnete 2D-Cartoon-Figur dieser Person sein. ok=false, wenn EINES zutrifft: (1) Bild 2 ist fotorealistisch oder 3D statt gezeichnet 2D. (2) In Bild 2 ist mehr als eine Person oder Figur. (3) Haarfarbe, Frisur oder Hautton passen offensichtlich nicht zu Bild 1. (4) Im Bild steht Schrift, Buchstaben oder Zahlen. (5) Die Figur ist abgeschnitten oder hat grobe Körperfehler. Vereinfachungen und Comic-Übertreibungen sind gewollt und OK. Antworte nur als JSON mit ok und einem kurzen grund auf Deutsch.'
        : modus === 'eigen'
        // Eigene Figur: Bild 1 ist das hochgeladene Bild, Bild 2 dieselbe Figur absichtlich im Pazzi-Look (3D) neu gezeichnet
        ? 'Bild 1 wurde von einem Nutzer als seine eigene Figur hochgeladen, Bild 2 ist dieselbe Figur, absichtlich in einem weichen 3D-Animationsfilm-Stil neu gezeichnet (der andere Stil ist gewollt und KEIN Grund für ok=false). ok=false, wenn EINES zutrifft: (1) Bild 1 oder Bild 2 zeigt eine bekannte, urheberrechtlich geschützte Figur oder ein Marken-Maskottchen (z. B. aus Disney, Pixar, Marvel, DC, Pokémon, Nintendo, Sanrio, Looney Tunes, Peanuts, Anime-Serien, Videospielen oder Werbung) – schreibe dann im grund das Wort „bekannt“. (2) Bild 1 zeigt eine echte Person als Foto statt einer Figur. (3) Bild 2 ist eine andere Figur als in Bild 1 (anderer Typ, anderes Gesicht, ganz andere Farben) oder nicht im 3D-Stil. (4) In Bild 2 steht Schrift, Buchstaben, Zahlen, ein Logo oder ein Wasserzeichen. (5) In Bild 2 ist mehr als eine Figur oder die Figur ist abgeschnitten oder hat grobe Körperfehler. Schrift oder Logos nur in Bild 1 sind kein Grund für ok=false, wenn sie in Bild 2 fehlen. Antworte nur als JSON mit ok und einem kurzen grund auf Deutsch.'
        : modus === 'figur'
        // Hauptbild/Figurenblatt: nur Figur und Schrift prüfen (Merkmal und Haltung ändern sich absichtlich)
        ? `Prüfe Bild 2. ok=false, wenn EINES zutrifft: (1) Es ist eine andere Figur als in Bild 1 (andere Tierart/Typ, anderes Gesicht oder ganz andere Farben). Neue Accessoires, Kleidung, Hintergrundfarbe oder Ausdruck sind gewollt und OK. (2) Im Bild steht Schrift, Buchstaben oder Zahlen. (3) Die Figur ist abgeschnitten oder hat grobe Körperfehler. ${szene ? `Hinweis zum Auftrag: ${szene}. ` : ''}Antworte nur als JSON mit ok und einem kurzen grund auf Deutsch.`
        : `Prüfe Bild 2 streng. ok=false, wenn EINES zutrifft: (1) Es ist nicht dieselbe Figur wie in Bild 1 (Tierart/Typ, Farben, Gesicht, Erkennungsmerkmal). (2) Im Bild steht Schrift, Buchstaben oder Zahlen. (3) Die Figur ist abgeschnitten oder hat grobe Körperfehler. (4) Es ist eine völlig andere Situation als: „${szene}“.${einfarbig ? ' (5) Der Hintergrund ist nicht einfarbig und flach (Raum, Wände, Boden, Fenster oder Landschaft sind zu sehen). Einzelne Gegenstände oder ein einzelnes Möbelstück, das zur Handlung gehört (Bett, Sofa, Spiegel, Tisch), sind erlaubt.' : ''} Kleine Abweichungen bei Details, Haltung, Kleidung, Gegenständen, Bildaufteilung oder viel freier Fläche sind OK und kein Grund für ok=false. Schrift heißt lesbare Buchstaben oder Wörter; Striche oder Symbole auf Bildschirmen und Papieren sind OK. Antworte nur als JSON mit ok und einem kurzen grund auf Deutsch.` },
      ...(mitTags ? [{ text: TAG_TEXT }] : []),
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, grund: { type: 'STRING' }, ...(mitTags ? { tags: TAG_SCHEMA } : {}) }, required: ['ok', 'grund'] },
    },
  });
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  try { return JSON.parse(text); } catch { return { ok: false, grund: 'Prüfung nicht lesbar' }; }
}
