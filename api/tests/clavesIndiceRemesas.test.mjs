/**
 * Ninguna escritura de Igp_Remesas puede olvidar las claves de índice:
 * un Put sin aplicarClavesRemesa, o un Update sin conClavesRemesa, deja
 * el ítem fuera del GSI o con gsi_activa colgando.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../routes/remesas.js', import.meta.url), 'utf8');

function escrituras(tipo) {
  const out = [];
  const re = new RegExp(`new ${tipo}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const abierto = src.indexOf('{', m.index);
    let depth = 0;
    let fin = abierto;
    for (; fin < src.length; fin += 1) {
      if (src[fin] === '{') depth += 1;
      else if (src[fin] === '}') {
        depth -= 1;
        if (depth === 0) {
          fin += 1;
          break;
        }
      }
    }
    const bloque = src.slice(m.index, fin);
    if (!/TableName:\s*TABLE\b/.test(bloque)) continue;
    out.push({ bloque, index: m.index });
  }
  return out;
}

test('cada Put de remesas llama a aplicarClavesRemesa justo antes', () => {
  const puts = escrituras('PutCommand');
  assert.equal(puts.length, 6);
  for (const { bloque, index } of puts) {
    const antes = src.slice(Math.max(0, index - 250), index);
    assert.match(`${antes}\n${bloque}`, /aplicarClavesRemesa\s*\(/);
  }
});

test('cada Update de remesas pasa por conClavesRemesa', () => {
  const updates = escrituras('UpdateCommand');
  assert.equal(updates.length, 5);
  for (const { index } of updates) {
    const alrededor = src.slice(index, index + 40);
    assert.match(alrededor, /new UpdateCommand\(\s*conClavesRemesa\s*\(/);
  }
});
