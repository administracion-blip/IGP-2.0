/**
 * Pruebas del IBAN extraído del texto OCR de una factura de gasto.
 *
 * El número de cuenta llega del OCR escrito de mil formas y rodeado de ruido
 * (nombre del banco, BIC, cuentas enmascaradas de domiciliación). Lo único que
 * separa un IBAN real de la basura es el módulo 97, así que estas pruebas fijan
 * las dos mitades del comportamiento: qué se acepta y qué se rechaza, y a qué
 * entidad se acaba asignando la cuenta, que es de lo que depende el alta rápida
 * de un proveedor nuevo desde el registro masivo.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extraerIbansDeTexto,
  extraerEntidadesCandidatas,
  netEmisorScore,
} from '../lib/ocrFacturaEntidades.js';

/** IBAN válidos (módulo 97) usados en todos los casos. */
const IBAN_EMISOR = 'ES9121000418450200051332';
const IBAN_CLIENTE = 'DE89370400440532013000';

/** Solo los IBAN, sin la posición, para comparar cómodamente. */
function ibansDe(texto) {
  return extraerIbansDeTexto(texto).map((x) => x.iban);
}

test('IBAN con espacios entre grupos', () => {
  assert.deepEqual(
    ibansDe('Forma de pago: transferencia\nIBAN: ES91 2100 0418 4502 0005 1332'),
    [IBAN_EMISOR],
  );
});

test('IBAN con guiones entre grupos', () => {
  assert.deepEqual(ibansDe('Cuenta ES91-2100-0418-4502-0005-1332 titular ACME'), [IBAN_EMISOR]);
});

test('IBAN todo junto y con el prefijo IBAN pegado delante', () => {
  assert.deepEqual(ibansDe('IBANES9121000418450200051332'), [IBAN_EMISOR]);
});

test('IBAN partido por un salto de línea del OCR', () => {
  assert.deepEqual(ibansDe('IBAN ES91 2100 0418 4502\n0005 1332'), [IBAN_EMISOR]);
});

test('IBAN seguido del nombre del banco o del BIC: el texto de detrás no entra en la cuenta', () => {
  assert.deepEqual(ibansDe('ES91 2100 0418 4502 0005 1332 BANCO POPULAR ESPAÑOL'), [IBAN_EMISOR]);
  assert.deepEqual(ibansDe('IBAN ES91 2100 0418 4502 0005 1332 BIC BSCHESMM'), [IBAN_EMISOR]);
});

test('IBAN en minúsculas: se normaliza a mayúsculas', () => {
  assert.deepEqual(ibansDe('iban es91 2100 0418 4502 0005 1332'), [IBAN_EMISOR]);
});

test('dos IBAN en el mismo documento: se devuelven los dos, en orden de aparición', () => {
  const texto =
    'Ingreso en ES91 2100 0418 4502 0005 1332\nAdeudo al cliente en DE89 3704 0044 0532 0130 00';
  assert.deepEqual(ibansDe(texto), [IBAN_EMISOR, IBAN_CLIENTE]);
});

test('cuenta enmascarada con asteriscos: se descarta', () => {
  assert.deepEqual(ibansDe('Domiciliado en ES** **** **** 1234'), []);
  assert.deepEqual(ibansDe('Domiciliado en ES12 **** **** **** **** 1234'), []);
});

test('dígito de control cambiado: se descarta aunque tenga forma de IBAN', () => {
  assert.deepEqual(ibansDe('IBAN: ES92 2100 0418 4502 0005 1332'), []);
});

/**
 * Emisor y cliente separados por texto suficiente para que el CIF del emisor no
 * quede dentro del radio de contexto de la etiqueta «Cliente».
 */
const FACTURA_DOS_CIF = `PESCADOS DEL SUR S.L.
CIF: B12345674
C/ Mayor 12, 28001 MADRID
Telf. 910 000 000 - pedidos@pescadosdelsur.example
Inscrita en el Registro Mercantil de Madrid, tomo 1234, folio 56, hoja M-7890
FACTURA Nº F-2026/001
Fecha factura: 03/02/2026
Descripción: suministro de pescado fresco para los locales del grupo

Cliente: PARIPE GRUPO SL
NIF: B87654321
Avda. Andalucia 5, 41001 SEVILLA

Base imponible: 100,00 €
IVA 10%: 10,00 €
Total factura: 110,00 €

Pago por transferencia a IBAN ES91 2100 0418 4502 0005 1332 - Banco Santander`;

test('un solo IBAN en la factura: va a la entidad con mejor puntuación de emisor y la otra queda vacía', () => {
  const entidades = extraerEntidadesCandidatas(FACTURA_DOS_CIF);
  assert.equal(entidades.length, 2);

  const emisor = entidades.find((e) => e.cif === 'B12345674');
  const cliente = entidades.find((e) => e.cif === 'B87654321');
  assert.ok(emisor && cliente, 'deben detectarse los dos CIF del documento');
  assert.ok(
    netEmisorScore(emisor) > netEmisorScore(cliente),
    'el emisor debe puntuar por encima del cliente',
  );

  assert.equal(emisor.iban_candidato, IBAN_EMISOR);
  assert.equal(cliente.iban_candidato, '');
});
