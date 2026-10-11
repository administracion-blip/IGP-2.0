import nodemailer from 'nodemailer';

export { escapeHtml, textoPlanoAHtml } from './seguridad/escapeHtml.js';

/**
 * Transporte SMTP compartido para todo el backend (facturación, informes, etc.).
 * Reutiliza las variables SMTP_* ya existentes. Se crea de forma perezosa para no
 * fallar al arrancar si SMTP no está configurado en entornos sin correo.
 */
let transport = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
    });
  }
  return transport;
}

/** Sustituye el transporte (pruebas). `null` vuelve al SMTP real. */
export function establecerTransporteEmail(t) {
  transport = t;
}

/** Indica si el SMTP está configurado (hay credenciales mínimas). */
export function smtpConfigurado() {
  return Boolean(process.env.SMTP_USER);
}

export const MENSAJE_DESTINATARIO_RECHAZADO = 'El servidor de correo rechazó el destinatario; revisa la dirección';

const CODIGOS_SMTP_DESTINATARIO = new Set([550, 553]);

/**
 * Error 400 para el cliente si `err` es un rechazo SMTP del destinatario (nodemailer:
 * `code: 'EENVELOPE'` o `responseCode` 550/553 en el RCPT TO); `null` si es otro fallo.
 * El texto del servidor SMTP no se copia al mensaje.
 */
export function errorDestinatarioRechazado(err) {
  if (!err || typeof err !== 'object') return null;
  const comando = String(err.command || '').trim().toUpperCase();
  if (comando && !comando.startsWith('RCPT')) return null;
  const rechazo = err.code === 'EENVELOPE' || CODIGOS_SMTP_DESTINATARIO.has(Number(err.responseCode));
  if (!rechazo) return null;
  return Object.assign(new Error(MENSAJE_DESTINATARIO_RECHAZADO), { status: 400 });
}

/**
 * Envía un email. `attachments` sigue el formato de nodemailer
 * (p. ej. `[{ filename, content: Buffer, contentType }]`).
 */
export async function enviarEmail({ to, subject, html, text, attachments, from }) {
  if (!smtpConfigurado()) {
    throw new Error('SMTP no configurado. Define SMTP_HOST, SMTP_USER y SMTP_PASS en variables de entorno.');
  }
  return getTransport().sendMail({
    from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    attachments: attachments || [],
  });
}
