/**
 * Banca — importación de extractos bancarios y consulta de movimientos.
 *
 * La ingesta (idempotencia, solapamiento, escritura) vive en `lib/banca/`; aquí
 * solo se validan la petición y los permisos, y se traduce el resultado a HTTP.
 * Los movimientos nacen en estado `pendiente`: la conciliación con facturas es
 * otra fase.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { requirePermission } from '../middleware/auth.js';
import { limpiarIban, validarIban } from '../lib/remesas/iban.js';
import { detectarLector, EXTENSIONES_EXTRACTO, listarFormatos } from '../lib/banca/lectores.js';
import { contarMovimientos } from '../lib/banca/canonico.js';
import { ingestarExtracto } from '../lib/banca/ingesta.js';
import { subirExtractoOriginal, urlExtractoOriginal, borrarExtractoOriginal } from '../lib/banca/s3.js';
import {
  getFicheroCarga,
  listarFicherosCarga,
  listarMovimientosDeCarga,
  borrarMovimientos,
  borrarFicheroCarga,
  queryMovimientosCuenta,
  queryMovimientosEmpresa,
  queryMovimientosEstado,
  marcarCuentaAsignadaEnFichero,
  ESTADO_FICHERO_EN_CURSO,
} from '../lib/banca/store.js';
import { getNombreFromEmpresaItem } from '../lib/empresaCif.js';
import { buscarEmpresaPorIdEmpresa } from '../lib/facturacion/ibanCongelado.js';
import {
  altaCuentaBancariaEmpresa,
  httpErrorAltaCuenta,
} from '../lib/empresaCuentaAlta.js';

const router = Router();

/**
 * Los extractos no son PDF ni imágenes, así que la allowlist de facturas
 * (`multerFacturaFileFilter`) no sirve y no se toca: aquí se filtra por
 * extensión, porque el MIME que manda el navegador para un .q43 es
 * `application/octet-stream` o `text/plain` según el sistema.
 */
function filtroExtracto(_req, file, cb) {
  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  if (!EXTENSIONES_EXTRACTO.includes(ext)) {
    const err = new Error(
      `Tipo de archivo no permitido. Se aceptan: ${EXTENSIONES_EXTRACTO.join(', ')}`,
    );
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: filtroExtracto,
});

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function esVerdadero(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sí';
}

function fechaOpcional(valor) {
  const v = String(valor || '').trim();
  return RE_FECHA.test(v) ? v : '';
}

function usuarioDeReq(req) {
  const u = req.user || {};
  return String(u.email || u.sub || '').trim();
}

/**
 * Booleano estricto (mismo criterio que `POST /empresas/:id/cuentas`).
 * @returns {boolean|null}
 */
function leerBooleano(val) {
  if (val === true || val === 'true') return true;
  if (val === false || val === 'false') return false;
  return null;
}

/** Localiza la cuenta del resumen de carga por IBAN o cuentaRef. */
function cuentaPendienteEnFichero(fichero, clave) {
  const buscada = limpiarIban(clave) || String(clave || '').trim();
  if (!buscada) return null;
  return (fichero?.cuentas || []).find((c) => {
    const iban = limpiarIban(c?.iban) || String(c?.iban || '').trim();
    const ref = limpiarIban(c?.cuentaRef) || String(c?.cuentaRef || '').trim();
    return iban === buscada || ref === buscada;
  }) || null;
}

/** El PK/SK no aportan nada al cliente: la identidad visible es iban + movementHash. */
function movimientoToApi(item) {
  if (!item) return null;
  const { PK, SK, ...resto } = item;
  return resto;
}

/** GET /api/banca/formatos — formatos de extracto que se saben leer. */
router.get('/banca/formatos', requirePermission('banca.ver'), (_req, res) => {
  res.json({ ok: true, formatos: listarFormatos() });
});

/** POST /api/banca/importar — sube un extracto y guarda sus movimientos. */
router.post(
  '/banca/importar',
  requirePermission('banca.importar'),
  upload.single('file'),
  async (req, res) => {
    const buffer = req.file?.buffer;
    if (!buffer?.length) {
      return res.status(400).json({ error: 'Falta el fichero del extracto (campo "file")' });
    }

    const nombreFichero = String(req.file.originalname || '').trim();
    const deteccion = detectarLector({ nombreFichero, formato: req.body?.formato });
    if (!deteccion.ok) {
      return res.status(400).json({ error: deteccion.motivo, code: deteccion.code });
    }
    const { lector } = deteccion;

    const ibanIndicado = limpiarIban(req.body?.iban);
    if (ibanIndicado) {
      const validacion = validarIban(ibanIndicado);
      if (!validacion.valido) {
        return res.status(400).json({ error: `IBAN indicado inválido: ${validacion.motivo}` });
      }
    }
    if (!lector.traeIban && !ibanIndicado) {
      return res.status(400).json({
        error: `Los extractos ${lector.nombre} no identifican la cuenta: indica el IBAN`,
        code: 'IBAN_REQUERIDO',
      });
    }

    let extracto;
    try {
      extracto = await lector.leer(buffer);
    } catch (err) {
      req.log?.error({ err }, '[banca/importar] el lector no pudo procesar el fichero');
      return res.status(400).json({ error: 'No se ha podido leer el extracto' });
    }

    if (contarMovimientos(extracto) === 0) {
      return res.status(400).json({
        error: 'El extracto no contiene ningún movimiento legible',
        errores: extracto.errores,
        avisos: extracto.avisos,
      });
    }

    // En Norma 43 el IBAN del body es una comprobación: si no cuadra con el del
    // fichero, lo más probable es que el usuario haya subido el extracto de otra
    // cuenta, y guardarlo mezclaría movimientos de dos cuentas.
    if (ibanIndicado && lector.traeIban) {
      const ibanesFichero = extracto.cuentas.map((c) => c.iban).filter(Boolean);
      if (!ibanesFichero.includes(ibanIndicado)) {
        return res.status(400).json({
          error: `El IBAN indicado (${ibanIndicado}) no coincide con el del fichero (${ibanesFichero.join(', ') || 'sin IBAN válido'})`,
          code: 'IBAN_NO_COINCIDE',
          ibanesFichero,
        });
      }
    }

    const confirmar = esVerdadero(req.body?.confirmar);
    const resultado = await ingestarExtracto({
      extracto,
      nombreFichero,
      tamanoBytes: req.file.size,
      usuario: usuarioDeReq(req),
      confirmar,
      guardarOriginal: () => subirExtractoOriginal({
        buffer,
        hashFichero: extracto.hashFichero,
        nombreFichero,
        tipoMime: req.file.mimetype,
      }),
    });

    if (!resultado.ok) {
      return res.status(409).json({
        ok: false,
        code: resultado.code,
        error: 'La cuenta ya tiene movimientos guardados en el rango del extracto',
        mensaje: 'Revisa el solapamiento y vuelve a enviar con confirmar=true si quieres importarlo igualmente',
        solapamientos: resultado.solapamientos,
      });
    }

    return res.json({
      ok: true,
      yaCargado: resultado.yaCargado,
      ...(resultado.yaCargado && {
        mensaje: 'Este fichero ya estaba cargado: no se ha reprocesado',
      }),
      resumen: resultado.carga,
    });
  },
);

/** GET /api/banca/movimientos — por cuenta, por empresa o por estado. */
router.get('/banca/movimientos', requirePermission('banca.ver'), async (req, res) => {
  const iban = limpiarIban(req.query.iban);
  const empresaId = String(req.query.empresaId || '').trim();
  const estado = String(req.query.estado || '').trim();
  const desde = fechaOpcional(req.query.desde);
  const hasta = fechaOpcional(req.query.hasta);
  const limite = req.query.limite ?? req.query.limit;
  const cursor = String(req.query.cursor || '').trim();

  if (req.query.desde && !desde) return res.status(400).json({ error: 'desde debe ser YYYY-MM-DD' });
  if (req.query.hasta && !hasta) return res.status(400).json({ error: 'hasta debe ser YYYY-MM-DD' });

  let salida;
  if (iban) {
    salida = await queryMovimientosCuenta(iban, { desde, hasta, estado, limite, cursor });
  } else if (empresaId) {
    salida = await queryMovimientosEmpresa(empresaId, { desde, hasta, estado, limite, cursor });
  } else if (estado) {
    salida = await queryMovimientosEstado(estado, { desde, hasta, limite, cursor });
  } else {
    return res.status(400).json({
      error: 'Indica al menos iban, empresaId o estado para consultar movimientos',
    });
  }

  res.json({
    ok: true,
    movimientos: salida.movimientos.map(movimientoToApi),
    cursor: salida.cursor,
    filtros: { iban, empresaId, estado: estado || '', desde, hasta },
  });
});

/** GET /api/banca/ficheros — cargas de extractos, lo más reciente primero. */
router.get('/banca/ficheros', requirePermission('banca.ver'), async (req, res) => {
  const ficheros = await listarFicherosCarga({
    desde: fechaOpcional(req.query.desde),
    hasta: fechaOpcional(req.query.hasta),
    estado: String(req.query.estado || '').trim(),
    iban: limpiarIban(req.query.iban),
    limite: req.query.limite ?? req.query.limit,
  });
  res.json({ ok: true, ficheros });
});

/** GET /api/banca/ficheros/:hashFichero — detalle de una carga. */
router.get('/banca/ficheros/:hashFichero', requirePermission('banca.ver'), async (req, res) => {
  const fichero = await getFicheroCarga(req.params.hashFichero);
  if (!fichero) return res.status(404).json({ error: 'Carga no encontrada' });

  let urlOriginal = '';
  if (fichero.s3Key) {
    try {
      urlOriginal = await urlExtractoOriginal(fichero.s3Key);
    } catch (err) {
      req.log?.warn({ err }, '[banca/ficheros] no se pudo firmar la URL del original');
    }
  }
  res.json({ ok: true, fichero, urlOriginal });
});

/**
 * POST /api/banca/ficheros/:hashFichero/asignar-cuenta — da de alta en el
 * maestro el IBAN que quedó `pendiente_cuenta` y actualiza la ficha de carga.
 * Permiso `empresas.editar`: está creando/reactivando cuenta de empresa.
 */
router.post(
  '/banca/ficheros/:hashFichero/asignar-cuenta',
  requirePermission('empresas.editar'),
  async (req, res) => {
    const hash = String(req.params.hashFichero || '').trim();
    if (!hash) return res.status(400).json({ error: 'Falta el hash del fichero' });

    const body = req.body || {};
    const empresaId = String(body.empresaId || '').trim();
    if (!empresaId) return res.status(400).json({ error: 'empresaId es obligatorio' });

    const claveCuenta = limpiarIban(body.iban) || String(body.cuentaRef || '').trim();
    if (!claveCuenta) {
      return res.status(400).json({ error: 'iban o cuentaRef es obligatorio' });
    }

    const predeterminada = leerBooleano(body.predeterminada);
    if (predeterminada === null) {
      return res.status(400).json({ error: 'predeterminada debe ser true o false' });
    }

    try {
      const fichero = await getFicheroCarga(hash);
      if (!fichero) return res.status(404).json({ error: 'Carga no encontrada' });
      if (fichero.estado === ESTADO_FICHERO_EN_CURSO) {
        return res.status(409).json({ error: 'La carga aún está en curso; reintenta más tarde' });
      }

      const cuentaExtracto = cuentaPendienteEnFichero(fichero, claveCuenta);
      if (!cuentaExtracto) {
        return res.status(404).json({ error: 'Esa cuenta no aparece en esta carga' });
      }
      if (cuentaExtracto.pendienteAsignar !== true) {
        return res.status(409).json({
          error: 'Esa cuenta del extracto ya está asignada a una empresa',
          empresaId: cuentaExtracto.empresaId || '',
          empresaNombre: cuentaExtracto.empresaNombre || '',
        });
      }

      const empresa = await buscarEmpresaPorIdEmpresa(empresaId);
      if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

      // Preferimos el IBAN del body; si solo vino cuentaRef, usamos el del extracto.
      const ibanAlta = limpiarIban(body.iban)
        || limpiarIban(cuentaExtracto.iban)
        || String(cuentaExtracto.cuentaRef || '').trim();

      const alta = await altaCuentaBancariaEmpresa(empresa, {
        iban: ibanAlta,
        bancoCodigo: body.bancoCodigo,
        bancoNombre: body.bancoNombre,
        notas: body.notas,
        predeterminada,
        usuario: usuarioDeReq(req),
      });

      if (!alta.ok) {
        const { status, body: errorBody } = httpErrorAltaCuenta(alta);
        return res.status(status).json(errorBody);
      }

      const ficheroActualizado = await marcarCuentaAsignadaEnFichero(
        hash,
        claveCuenta,
        {
          empresaId: String(alta.cuenta?.empresaId || empresaId).trim(),
          empresaNombre: getNombreFromEmpresaItem(empresa),
        },
      );

      return res.json({
        ok: true,
        cuenta: alta.cuenta,
        reactivada: alta.reactivada,
        ibanPredeterminado: alta.ibanPredeterminado,
        movimientosAsignados: alta.movimientosAsignados,
        fichero: ficheroActualizado || fichero,
      });
    } catch (err) {
      req.log?.error({ err }, '[banca/asignar-cuenta] error');
      return res.status(500).json({ error: err.message || 'Error al asignar la cuenta' });
    }
  },
);

/**
 * DELETE /api/banca/ficheros/:hashFichero — borra la carga, sus movimientos y
 * el original en S3, para poder reimportar el extracto limpio.
 */
router.delete('/banca/ficheros/:hashFichero', requirePermission('banca.importar'), async (req, res) => {
  const hash = String(req.params.hashFichero || '').trim();
  if (!hash) return res.status(400).json({ error: 'Falta el hash del fichero' });

  const fichero = await getFicheroCarga(hash);
  if (!fichero) return res.status(404).json({ error: 'Carga no encontrada' });

  const movimientos = await listarMovimientosDeCarga(hash, fichero.cuentas);
  const movimientosBorrados = await borrarMovimientos(movimientos);
  await borrarFicheroCarga(hash);

  let originalBorrado = false;
  if (fichero.s3Key) {
    try {
      await borrarExtractoOriginal(fichero.s3Key);
      originalBorrado = true;
    } catch (err) {
      req.log?.warn({ err, s3Key: fichero.s3Key }, '[banca/ficheros] no se pudo borrar el original en S3');
    }
  }

  res.json({
    ok: true,
    hashFichero: hash,
    movimientosBorrados,
    originalBorrado,
  });
});

export default router;
