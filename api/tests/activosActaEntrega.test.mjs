import test from 'node:test';
import { strict as assert } from 'node:assert';
import sharp from 'sharp';
import { componerCuerpoActa, generarPdfActa, generarPdfInventarioCustodia, htmlActaATexto, renderActa } from '../lib/activos/actaEntrega.js';
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

test('generarPdfActa con JPEG y marcador <<<ITEMS>>> produce PDF', async () => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 80, b: 40 } },
  }).jpeg().toBuffer();
  const html = '<p>Antes</p><p><<<ITEMS>>></p><p>Después</p>';
  assert.match(htmlActaATexto(html), /<<<ITEMS>>>/);
  const pdf = await generarPdfActa(html, null, {
    items: [{ texto: 'CAMI-1 · Camiseta · Talla M · 1 ud.', jpeg }],
  });
  assert.ok(pdf?.length > 0);
  assert.equal(pdf.subarray(0, 4).toString('utf8'), '%PDF');
});

test('generarPdfActa sin items sigue generando PDF', async () => {
  const pdf = await generarPdfActa('<p>Acta de entrega</p><p>CAMI-1</p>', null);
  assert.ok(pdf?.length > 0);
  assert.equal(pdf.subarray(0, 4).toString('utf8'), '%PDF');
});

test('generarPdfActa con dos {{items}} no deja el marcador en el PDF', async () => {
  const pdf = await generarPdfActa('<p><<<ITEMS>>></p><p>medio</p><p><<<ITEMS>>></p>', null, {
    items: [{ texto: 'CAMI-1 · Camiseta · 1 ud.' }],
  });
  assert.equal(pdf.subarray(0, 4).toString('utf8'), '%PDF');
  assert.doesNotMatch(pdf.toString('latin1'), /<<<ITEMS>>>/);
});

test('generarPdfInventarioCustodia sin jpeg produce PDF', async () => {
  const pdf = await generarPdfInventarioCustodia({
    trabajador: 'Ana López',
    fecha: '18/9/2026',
    cantidad: 2,
    items: [{ texto: 'CAMI-1 · Camiseta · Talla M · 1 ud.' }],
  });
  assert.ok(pdf?.length > 0);
  assert.equal(pdf.subarray(0, 4).toString('utf8'), '%PDF');
  const txt = pdf.toString('latin1');
  assert.match(txt, /Inventario de custodia/);
  assert.match(txt, /Documento informativo/);
});

test('generarPdfInventarioCustodia con JPEG produce PDF', async () => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 120, b: 200 } },
  }).jpeg().toBuffer();
  const pdf = await generarPdfInventarioCustodia({
    trabajador: 'Ana López',
    items: [{ texto: 'CAMI-1 · Camiseta · Talla M · 1 ud.', jpeg }],
  });
  assert.ok(pdf?.length > 0);
  assert.equal(pdf.subarray(0, 4).toString('utf8'), '%PDF');
});
