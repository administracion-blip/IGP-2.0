import { Router } from 'express';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { signToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { enviarEmail, smtpConfigurado } from '../lib/email.js';
import {
  INFORME_AJUSTE_PK,
  INFORME_AJUSTE_SK,
  diaAnterior,
  cargarMapaLocales,
  resolverDestinatarios,
  obtenerDatosInforme,
} from '../lib/informes/informeDiario.js';
import { generarPdfInformeDiario } from '../lib/informes/pdfInformeDiario.js';

const router = Router();

/** Roles que reciben el informe si no hay config guardada. */
const ROLES_DEFAULT = ['Administrador'];

async function leerConfig() {
  const r = await docClient.send(new GetCommand({
    TableName: tables.ajustes,
    Key: { PK: INFORME_AJUSTE_PK, SK: INFORME_AJUSTE_SK },
  })).catch(() => null);
  const item = r?.Item || {};
  return {
    enabled: item.Enabled === true,
    days: Array.isArray(item.Days) ? item.Days : [],
    times: Array.isArray(item.Times) ? item.Times : [],
    roles: Array.isArray(item.Roles) && item.Roles.length > 0 ? item.Roles : ROLES_DEFAULT,
    topLimit: Number.isFinite(Number(item.TopLimit)) ? Number(item.TopLimit) : 10,
  };
}

/** Solo Administrador (vía token) o llamada interna (job, sin req.user) pueden disparar el envío. */
function puedeEjecutar(req) {
  if (!req.user) return true; // llamada interna autenticada por X-Internal-Secret
  return req.user.rol === 'Administrador';
}

/**
 * Genera y envía el informe diario por email a cada destinatario (un PDF con sus locales).
 * Usado tanto por el botón "Forzar envío" (token de admin) como por el job programado
 * (cabecera X-Internal-Secret). Body opcional: { businessDay }.
 */
router.post('/informes/diario/enviar', async (req, res) => {
  if (!puedeEjecutar(req)) {
    return res.status(403).json({ error: 'Solo un administrador puede forzar el envío del informe.' });
  }
  if (!smtpConfigurado()) {
    return res.status(500).json({ error: 'SMTP no configurado. Define SMTP_HOST, SMTP_USER y SMTP_PASS.' });
  }

  const businessDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.businessDay || ''))
    ? String(req.body.businessDay)
    : diaAnterior();

  const port = process.env.PORT || 3002;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Para reutilizar /cajas/top y /exceptions: reenvía el token del usuario o, en
  // llamadas internas, firma uno de sistema con rol Administrador.
  const authHeader = req.headers.authorization
    || `Bearer ${signToken({ sub: 'sistema-informes', email: 'sistema@informes', rol: 'Administrador' })}`;

  try {
    const config = await leerConfig();
    const mapaLocales = await cargarMapaLocales();
    const destinatarios = await resolverDestinatarios({ rolesPermitidos: config.roles, mapaLocales });

    if (destinatarios.length === 0) {
      return res.json({ ok: true, businessDay, enviados: 0, errores: [], mensaje: 'No hay destinatarios con locales asignados.' });
    }

    let enviados = 0;
    const errores = [];

    for (const dest of destinatarios) {
      try {
        const datos = await obtenerDatosInforme({
          baseUrl,
          authHeader,
          businessDay,
          agoraCodes: dest.agoraCodes,
          topLimit: config.topLimit,
        });
        const pdf = await generarPdfInformeDiario(datos, {
          destinatarioNombre: dest.nombre,
          localesNombres: dest.localesNombres,
        });
        await enviarEmail({
          to: dest.email,
          subject: `Informe diario de jornadas — ${businessDay}`,
          html: `<p>Hola ${dest.nombre},</p>
            <p>Adjuntamos el informe diario de jornadas del <strong>${businessDay}</strong> para tus locales: ${dest.localesNombres.join(', ')}.</p>
            <p>Un saludo,<br/>IPG Hostelería</p>`,
          attachments: [{
            filename: `informe-diario-${businessDay}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          }],
        });
        enviados += 1;
      } catch (err) {
        logger.error({ err, email: dest.email }, '[informe-diario] error enviando');
        errores.push({ email: dest.email, error: err.message });
      }
    }

    // Registra el resultado en la config para mostrarlo en Ajustes
    await docClient.send(new UpdateCommand({
      TableName: tables.ajustes,
      Key: { PK: INFORME_AJUSTE_PK, SK: INFORME_AJUSTE_SK },
      UpdateExpression: 'SET UltimaEjecucion = :u, Estado = :e, Resultado = :r, updatedAt = :t',
      ExpressionAttributeValues: {
        ':u': new Date().toISOString(),
        ':e': errores.length === 0 ? 'ok' : 'parcial',
        ':r': `Enviados ${enviados}/${destinatarios.length} (${businessDay})`,
        ':t': new Date().toISOString(),
      },
    })).catch((err) => logger.warn({ err }, '[informe-diario] no se pudo registrar resultado'));

    return res.json({ ok: true, businessDay, enviados, total: destinatarios.length, errores });
  } catch (err) {
    logger.error({ err }, '[informe-diario] fallo general');
    return res.status(500).json({ error: err.message || 'Error generando el informe diario' });
  }
});

/**
 * Genera el PDF del informe diario y lo devuelve en base64 para descarga directa
 * (sin email). Por defecto consolida TODOS los locales del maestro; admite filtrar
 * con body.workplaceIds (coma o array). Body opcional: { businessDay, workplaceIds }.
 */
router.post('/informes/diario/descargar', async (req, res) => {
  if (!puedeEjecutar(req)) {
    return res.status(403).json({ error: 'Solo un administrador puede descargar el informe.' });
  }

  const businessDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.businessDay || ''))
    ? String(req.body.businessDay)
    : diaAnterior();

  const port = process.env.PORT || 3002;
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeader = req.headers.authorization
    || `Bearer ${signToken({ sub: 'sistema-informes', email: 'sistema@informes', rol: 'Administrador' })}`;

  try {
    const config = await leerConfig();
    const { agoraToNombre } = await cargarMapaLocales();

    let agoraCodes = [...agoraToNombre.keys()];
    const wpRaw = req.body?.workplaceIds;
    if (Array.isArray(wpRaw) && wpRaw.length > 0) {
      agoraCodes = wpRaw.map((v) => String(v).trim()).filter((c) => agoraToNombre.has(c));
    } else if (typeof wpRaw === 'string' && wpRaw.trim()) {
      agoraCodes = wpRaw.split(',').map((s) => s.trim()).filter((c) => agoraToNombre.has(c));
    }
    if (agoraCodes.length === 0) {
      return res.status(400).json({ error: 'No hay locales disponibles para el informe.' });
    }

    const localesNombres = agoraCodes.map((c) => agoraToNombre.get(c) || c);
    const datos = await obtenerDatosInforme({
      baseUrl,
      authHeader,
      businessDay,
      agoraCodes,
      topLimit: config.topLimit,
    });
    const pdf = await generarPdfInformeDiario(datos, { localesNombres });

    return res.json({
      ok: true,
      businessDay,
      filename: `informe-diario-${businessDay}.pdf`,
      pdfBase64: pdf.toString('base64'),
    });
  } catch (err) {
    logger.error({ err }, '[informe-diario] fallo en descarga');
    return res.status(500).json({ error: err.message || 'Error generando el informe diario' });
  }
});

/** Previsualiza qué usuarios recibirían el informe con la config actual (para Ajustes). */
router.get('/informes/diario/destinatarios', async (req, res) => {
  if (req.user && req.user.rol !== 'Administrador') {
    return res.status(403).json({ error: 'Solo un administrador puede consultar los destinatarios.' });
  }
  try {
    const config = await leerConfig();
    const destinatarios = await resolverDestinatarios({ rolesPermitidos: config.roles });
    return res.json({
      ok: true,
      roles: config.roles,
      count: destinatarios.length,
      destinatarios: destinatarios.map((d) => ({
        email: d.email,
        nombre: d.nombre,
        rol: d.rol,
        locales: d.localesNombres,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error resolviendo destinatarios' });
  }
});

export default router;
