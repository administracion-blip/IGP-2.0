import test from 'node:test';
import { strict as assert } from 'node:assert';
import { componerCuerpoActa, htmlActaATexto, renderActa } from '../lib/activos/actaEntrega.js';
import { bufferFirmaBase64 } from '../lib/activos/firma.js';

test('sin plantillas usa el acta por defecto', () => {
  const cuerpo = componerCuerpoActa([]);
  assert.match(cuerpo, /Acta de entrega/);
  assert.match(cuerpo, /\{\{items\}\}/);
});

test('varias plantillas: items solo en la primera', () => {
  const cuerpo = componerCuerpoActa([
    '<p>Uno {{items}}</p>',
    '<p>Dos {{items}} extra</p>',
  ]);
  const veces = cuerpo.split('{{items}}').length - 1;
  assert.equal(veces, 1);
  assert.match(cuerpo, /Uno/);
  assert.match(cuerpo, /Dos/);
});

test('html a texto conserva saltos y quita etiquetas', () => {
  const t = htmlActaATexto('<p>Hola <b>María</b></p><p>Ítem 1<br>Ítem 2</p>');
  assert.match(t, /Hola María/);
  assert.match(t, /Ítem 1/);
  assert.match(t, /Ítem 2/);
  assert.doesNotMatch(t, /</);
});

test('render rellena huecos', () => {
  const html = renderActa('<p>{{trabajador}} — {{items}}</p>', {
    trabajador: 'Ana',
    items: 'CAMI-1',
    fecha: '',
    local: '',
    entregado_por: '',
    firma: '',
  });
  assert.match(html, /Ana/);
  assert.match(html, /CAMI-1/);
});

test('firmaBase64: data URL y crudo dan el mismo PNG', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const crudo = png.toString('base64');
  assert.deepEqual(bufferFirmaBase64(`data:image/png;base64,${crudo}`), png);
  assert.deepEqual(bufferFirmaBase64(crudo), png);
});

test('firmaBase64 vacío o ausente no inventa buffer', () => {
  assert.equal(bufferFirmaBase64(''), null);
  assert.equal(bufferFirmaBase64(null), null);
  assert.equal(bufferFirmaBase64(undefined), null);
});
