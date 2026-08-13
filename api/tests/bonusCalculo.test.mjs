import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  IVA_FACTOR,
  baseFondo,
  desvGross,
  desvSinIvaFromGross,
  fondoComun,
  pctEfectivo,
  sinIva,
  totalBonus,
} from '../lib/bonus/bonusCalculo.js';

test('IVA_FACTOR es 1.10', () => {
  assert.equal(IVA_FACTOR, 1.10);
});

test('sinIva: 1100 → 1000', () => {
  assert.equal(sinIva(1100), 1000);
});

test('desvGross positiva solo si real > obj', () => {
  assert.equal(desvGross(1200, 1000), 200);
  assert.equal(desvGross(1000, 1000), 0);
  assert.equal(desvGross(800, 1000), 0);
});

test('desvSinIvaFromGross = desvGross / 1.10', () => {
  assert.equal(desvSinIvaFromGross(110), 100);
  assert.equal(desvSinIvaFromGross(0), 0);
});

test('baseFondo = desvSinIva (incentivos no se restan)', () => {
  assert.equal(baseFondo(100), 100);
  assert.equal(baseFondo(50), 50);
  assert.equal(baseFondo(0), 0);
});

test('fondoComun = max(0, base) * pct/100', () => {
  assert.equal(fondoComun(100, 20), 20);
  assert.equal(fondoComun(-30, 20), 0);
  assert.equal(fondoComun(100, 0), 0);
});

test('desv 0 + incentivo > 0 → fondo 0; incentivos se pagan igual; total = incentivos', () => {
  const desv = desvGross(900, 1000);
  assert.equal(desv, 0);
  const desvN = desvSinIvaFromGross(desv);
  const incentivos = 45;
  const base = baseFondo(desvN);
  assert.equal(base, 0);
  const fondo = fondoComun(base, 25);
  assert.equal(fondo, 0);
  assert.equal(incentivos, 45);
  assert.equal(totalBonus(incentivos, fondo), 45);
});

test('totalBonus = incentivos + fondo (independientes)', () => {
  assert.equal(totalBonus(200, 100), 300);
  assert.equal(totalBonus(200, 0), 200);
  assert.equal(totalBonus(0, 80), 80);
});

test('% sobre desv completa aunque haya incentivos', () => {
  const desvN = 1000;
  const incentivos = 200;
  const base = baseFondo(desvN);
  assert.equal(base, 1000);
  const fondo = fondoComun(base, 10);
  assert.equal(fondo, 100);
  assert.equal(totalBonus(incentivos, fondo), 300);
});

test('pctEfectivo: null local → global; override local gana; 0 local es válido', () => {
  assert.equal(pctEfectivo(null, 15), 15);
  assert.equal(pctEfectivo(undefined, 15), 15);
  assert.equal(pctEfectivo(25, 15), 25);
  assert.equal(pctEfectivo(0, 15), 0);
});
