// KI-Auftrag ausführen. Weg "vertex" (FLOW_KI_WEG=vertex): Claude über Google Vertex im Projekt des Dienstkontos
// (FLOW_VERTEX_KEY). Klappt das nicht, springt Claude Code mit dem Abo ein (Transport "abo"):
// eigener System-Prompt, keine Werkzeuge, gleiches Modell, gleiche Token-Grenze, gleiches Antwortformat wie über die API.
import { spawn } from 'node:child_process';
import { zugang } from './vertex.mjs';

export async function kiAusfuehren(a) {
  if (process.env.FLOW_KI_WEG === 'vertex') {
    try {
      return await kiPerVertex(a);
    } catch (e) {
      console.log(`KI über Vertex fehlgeschlagen, Abo springt ein: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return kiPerAbo(a);
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

/** Claude über Vertex: Antwort über ein erzwungenes Werkzeug, damit das JSON-Format fest ist. */
async function kiPerVertex(a) {
  const z = await zugang();
  const ort = process.env.FLOW_KI_ORT ?? 'global';
  const host = ort === 'global' ? 'aiplatform.googleapis.com' : `${ort}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${z.projekt}/locations/${ort}/publishers/anthropic/models/${a.modell}:rawPredict`;
  const body = JSON.stringify({
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: a.max_tokens, system: a.system,
    messages: [{ role: 'user', content: a.nachricht }],
    tools: [{ name: 'ergebnis', description: 'Gib das Ergebnis genau in diesem Format zurück.', input_schema: a.schema }],
    tool_choice: { type: 'tool', name: 'ergebnis' },
  });
  let letzte = '';
  for (let v = 0; v < 3; v++) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${z.wert}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5 * 60 * 1000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const teil = (j.content ?? []).find((b) => b.type === 'tool_use');
      if (!teil) throw new Error('Vertex: keine Antwort im festen Format');
      const u = j.usage ?? {};
      return { daten: teil.input, nutzung: { modell: a.modell, ein: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), aus: u.output_tokens ?? 0 } };
    }
    letzte = `Vertex HTTP ${r.status}: ${j.error?.message ?? ''}`.slice(0, 300);
    if (r.status !== 429 && r.status < 500) break;
    await schlaf(8000 * (v + 1));
  }
  throw new Error(letzte);
}

function kiPerAbo(a) {
  return new Promise((ok, fehl) => {
    const args = [
      '-p', '--output-format', 'json', '--model', a.modell, '--effort', a.effort ?? 'low',
      '--system-prompt', a.system, '--json-schema', JSON.stringify(a.schema),
      '--tools', '', '--no-session-persistence', '--strict-mcp-config',
    ];
    const p = spawn('claude', args, {
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(a.max_tokens), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let aus = '', err = '';
    const zeit = setTimeout(() => { p.kill('SIGKILL'); fehl(new Error('Zeitüberschreitung KI')); }, 5 * 60 * 1000);
    p.stdout.on('data', (d) => (aus += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(zeit);
      let j;
      try { j = JSON.parse(aus); } catch { return fehl(new Error(`Claude-Ausgabe nicht lesbar (Code ${code}): ${err.slice(0, 200)}`)); }
      if (j.is_error) return fehl(new Error(`Claude-Fehler: ${String(j.result).slice(0, 300)}`));
      let daten = j.structured_output;
      if (!daten) { try { daten = JSON.parse(j.result); } catch { return fehl(new Error('Keine strukturierte Antwort')); } }
      const u = j.usage ?? {};
      ok({ daten, nutzung: { modell: a.modell, ein: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), aus: u.output_tokens ?? 0 } });
    });
    p.stdin.end(a.nachricht);
  });
}
