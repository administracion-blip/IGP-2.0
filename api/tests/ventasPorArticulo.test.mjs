import test from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalFamilyId } from '../lib/mia/gruposFamilias.js';
import {
  agregarPorProductId,
  enriquecerYFiltrarFamilias,
  anotarPcts,
  datosParaPromptVentasPorArticulo,
  finalizarRankingArticulos,
  parseIdList,
} from '../lib/ia/motores/ventasPorArticulo.js';

test('parseIdList acepta array y CSV', () => {
  assert.deepEqual(parseIdList(['a', ' b ']), ['a', 'b']);
  assert.deepEqual(parseIdList('1,2; 3'), ['1', '2', '3']);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(null), []);
});

test('agregarPorProductId suma unidades/importe y prefiere nombre reciente', () => {
  const byId = agregarPorProductId([
    { ProductId: 'P1', ProductName: 'Viejo', Unidades: 2, ImporteBruto: 10, Fecha: '2026-01-01' },
    { ProductId: 'P1', ProductName: 'Nuevo', Unidades: 3, ImporteBruto: 15.5, Fecha: '2026-01-10' },
    { ProductId: 'P2', ProductName: '', Unidades: 1, ImporteBruto: 5, Fecha: '2026-01-05' },
  ]);
  assert.equal(byId.get('P1').unidades, 5);
  assert.equal(byId.get('P1').importe, 25.5);
  assert.equal(byId.get('P1').productName, 'Nuevo');
  assert.equal(byId.get('P2').productName, 'P2');
});

test('filtro familia canónico 01 vs 1; sin familia excluido con filtro', () => {
  assert.equal(canonicalFamilyId('01'), '1');
  assert.equal(canonicalFamilyId('1'), '1');

  const byId = agregarPorProductId([
    { ProductId: 'A', ProductName: 'Con fam', Unidades: 1, ImporteBruto: 10, Fecha: '2026-01-01' },
    { ProductId: 'B', ProductName: 'Sin fam', Unidades: 2, ImporteBruto: 20, Fecha: '2026-01-01' },
    { ProductId: 'C', ProductName: 'Otra fam', Unidades: 1, ImporteBruto: 5, Fecha: '2026-01-01' },
  ]);
  const productsMap = new Map([
    ['A', { FamilyId: '01', FamilyName: 'Bebidas' }],
    ['B', { FamilyId: '', FamilyName: '' }],
    ['C', { FamilyId: '2', FamilyName: 'Comida' }],
  ]);

  const filtrado = enriquecerYFiltrarFamilias(byId, productsMap, new Set(['1']));
  assert.equal(filtrado.articulos.length, 1);
  assert.equal(filtrado.articulos[0].productId, 'A');
  assert.equal(filtrado.articulos[0].familyId, '1');
  assert.equal(filtrado.sinFamilia, 1);

  const sinFiltro = enriquecerYFiltrarFamilias(byId, productsMap, null);
  assert.equal(sinFiltro.articulos.length, 3);
  const sinFam = sinFiltro.articulos.find((a) => a.productId === 'B');
  assert.equal(sinFam.familyId, '');
  assert.equal(sinFam.familyName, 'Sin familia');
});

test('anotarPcts calcula porcentajes sobre totales', () => {
  const articulos = [
    { productId: '1', unidades: 25, importe: 40 },
    { productId: '2', unidades: 75, importe: 60 },
  ];
  anotarPcts(articulos, { unidades: 100, importe: 100 });
  assert.equal(articulos[0].pctUnidades, 25);
  assert.equal(articulos[0].pctImporte, 40);
  assert.equal(articulos[1].pctUnidades, 75);
  assert.equal(articulos[1].pctImporte, 60);
});

test('datosParaPromptVentasPorArticulo recorta a top 50', () => {
  const articulos = Array.from({ length: 80 }, (_, i) => ({
    productId: String(i),
    productName: `Art ${i}`,
    importe: 100 - i,
    unidades: 1,
  }));
  const prompt = datosParaPromptVentasPorArticulo({
    meta: { topPrompt: 50 },
    totales: { unidades: 80, importe: 1000, numArticulos: 80 },
    porFamilia: [{ familyId: '1', familyName: 'X', importe: 10 }],
    articulos,
    avisos: ['ok'],
  });
  assert.equal(prompt.articulos.length, 50);
  assert.equal(prompt.articulos[0].productId, '0');
  assert.deepEqual(prompt.totales.numArticulos, 80);
  assert.equal(prompt.porFamilia.length, 1);
  assert.deepEqual(prompt.avisos, ['ok']);
});

test('finalizarRankingArticulos ordena por unidades desc', () => {
  const { articulos, totales } = finalizarRankingArticulos(
    [
      { productId: 'A', productName: 'Poco', unidades: 2, importe: 100, familyId: '1', familyName: 'F' },
      { productId: 'B', productName: 'Mucho', unidades: 50, importe: 10, familyId: '1', familyName: 'F' },
    ],
    { incluirSubtotales: false },
  );
  assert.equal(articulos[0].productId, 'B');
  assert.equal(articulos[1].productId, 'A');
  assert.equal(totales.unidades, 52);
  assert.equal(articulos[0].pctUnidades, 96.15);
});

test('datosParaPrompt incluye porLocal recortado', () => {
  const articulos = Array.from({ length: 20 }, (_, i) => ({
    productId: String(i),
    productName: `Art ${i}`,
    unidades: 20 - i,
    importe: 1,
  }));
  const prompt = datosParaPromptVentasPorArticulo({
    meta: { agruparPorLocal: true },
    totales: { unidades: 100 },
    articulos,
    porLocal: [
      {
        localId: '1',
        nombre: 'Local A',
        totales: { unidades: 10 },
        articulos,
      },
    ],
    avisos: [],
  });
  assert.ok(Array.isArray(prompt.porLocal));
  assert.equal(prompt.porLocal.length, 1);
  assert.ok(prompt.porLocal[0].articulos.length <= 20);
});
