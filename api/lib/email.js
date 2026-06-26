import nodemailer from 'nodemailer';

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

/** Indica si el SMTP está configurado (hay credenciales mínimas). */
export function smtpConfigurado() {
  return Boolean(process.env.SMTP_USER);
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
