import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.local') });
dotenv.config({ path: join(__dirname, '.env') });

import express from 'express';
// Atrapa promesas rechazadas en handlers async sin try/catch y las envía
// al middleware de error central. Debe importarse antes de definir cualquier ruta.
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { validateEnv } from './lib/validateEnv.js';
import { errorHandler } from './middleware/errorHandler.js';
import { tables } from './lib/db.js';
import { requireAuth } from './middleware/auth.js';
import { ensureComprasGSI } from './lib/dynamo/comprasProveedor.js';
import { ensureUsuariosEmailGSI } from './lib/dynamo/usuarios.js';
import { ensureMarketingGSIs } from './lib/dynamo/marketing.js';
import { ensureVentasProductoGSI } from './lib/dynamo/ventasProducto.js';
import {
  runCloseoutsSync,
  runSalesLinesSync,
  checkAutoSyncs,
  checkInformeDiario,
  checkVencimientosFacturas,
  SYNC_CLOSEOUTS_ENABLED,
  SYNC_CLOSEOUTS_INTERVAL_MS,
  SYNC_CLOSEOUTS_RECENT_DAYS,
  SYNC_SCHEDULER_INTERVAL_MS,
  SYNC_SALES_LINES_ENABLED,
  VENCIMIENTOS_INTERVAL_MS,
} from './lib/jobs/scheduledTasks.js';
import facturacionRouter from './routes/facturacion.js';
import artistasActuacionesRouter from './routes/artistasActuaciones.js';
import arqueosRealesRouter from './routes/arqueosReales.js';
import movimientosCajaRouter from './routes/movimientosCaja.js';
import mysteryGuestRouter from './routes/mysteryGuest.js';
import personalRouter from './routes/personal.js';
import cuadranteRouter from './routes/cuadrante.js';
import authRouter from './routes/auth.js';
import publicRouter from './routes/public.js';
import usuariosRouter from './routes/usuarios.js';
import productosRouter from './routes/productos.js';
import almacenesRouter from './routes/almacenes.js';
import localesRouter from './routes/locales.js';
import empresasRouter from './routes/empresas.js';
import permisosRouter from './routes/permisos.js';
import rolesRouter from './routes/roles.js';
import festivosRouter from './routes/festivos.js';
import placesRouter from './routes/places.js';
import pedidosRouter from './routes/pedidos.js';
import mantenimientoRouter from './routes/mantenimiento.js';
import limpiezaRouter from './routes/limpieza.js';
import agoraRouter from './routes/agora.js';
import acuerdosRouter from './routes/acuerdos.js';
import ajustesRouter from './routes/ajustes.js';
import marketingRouter from './routes/marketing.js';
import informesRouter from './routes/informes.js';
import activacionesRouter from './routes/activaciones.js';
import campanasRouter from './routes/campanas.js';
import remesasRouter from './routes/remesas.js';
import cashflowRouter from './routes/cashflow.js';
import iaRouter from './routes/ia.js';

// Valida variables críticas al arranque. Si falta alguna REQUIRED, aborta el proceso.
validateEnv();

const app = express();

// --- Logging HTTP estructurado (req.log disponible en cada handler). ---
app.use(pinoHttp({ logger }));

// --- Helmet: headers de seguridad HTTP ---
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// --- CORS: restringido por entorno ---
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:8084',
  'http://127.0.0.1:8084',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
];
const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...DEFAULT_DEV_ORIGINS, ...envOrigins]);

if (process.env.NODE_ENV === 'production' && envOrigins.length === 0) {
  logger.warn(
    '[CORS] NODE_ENV=production pero CORS_ALLOWED_ORIGINS está vacío. Solo se aceptarán los orígenes de desarrollo (localhost). Define la variable en .env si la app está accesible desde un dominio público.',
  );
}

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));

/** Mystery Guest y otros envían base64 (fotos); el límite por defecto (~100kb) rompe el guardado. */
app.use(express.json({ limit: '15mb' }));

// --- Rate limiting ---
const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '15', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Inténtalo de nuevo más tarde.' },
});
app.post('/api/login', loginLimiter);

// Límite específico para recuperación de contraseña: evita usarlo para spam de
// correos o enumeración de usuarios. Más restrictivo que el login.
const forgotPasswordLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_FORGOT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_FORGOT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de recuperación. Inténtalo de nuevo más tarde.' },
});
app.post('/api/forgot-password', forgotPasswordLimiter);

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
  message: { error: 'Demasiadas peticiones. Inténtalo de nuevo más tarde.' },
});
app.use('/api', apiLimiter);

// Health check para verificar que el API está en marcha
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'API ERP OK', port: process.env.PORT || 3002 });
});

// --- Rutas públicas (sin requireAuth global): authRouter expone /login público
//     y /me con su propio requireAuth de ruta. /api/health ya está arriba. ---
app.use('/api', authRouter);
app.use('/api', publicRouter);

// --- A partir de aquí, TODO /api requiere token Bearer válido. ---
app.use('/api', requireAuth);

app.use('/api', agoraRouter);
ensureComprasGSI();
ensureUsuariosEmailGSI();
ensureMarketingGSIs();
ensureVentasProductoGSI();
app.use('/api', acuerdosRouter);

app.use('/api', usuariosRouter);
app.use('/api', productosRouter);
app.use('/api', almacenesRouter);
app.use('/api', localesRouter);
app.use('/api', empresasRouter);
app.use('/api', permisosRouter);
app.use('/api', rolesRouter);
app.use('/api', festivosRouter);
app.use('/api', placesRouter);
app.use('/api', pedidosRouter);
app.use('/api', mantenimientoRouter);
app.use('/api', limpiezaRouter);
app.use('/api', facturacionRouter);
app.use('/api', artistasActuacionesRouter);
app.use('/api', arqueosRealesRouter);
app.use('/api', movimientosCajaRouter);
app.use('/api', mysteryGuestRouter);
app.use('/api', personalRouter);
app.use('/api', cuadranteRouter);
app.use('/api', ajustesRouter);
app.use('/api', marketingRouter);
app.use('/api', informesRouter);
app.use('/api', activacionesRouter);
app.use('/api', campanasRouter);
app.use('/api', remesasRouter);
app.use('/api', cashflowRouter);
app.use('/api', iaRouter);

// --- Middleware central de errores: DEBE ir tras todos los routers ---
app.use(errorHandler);

const port = process.env.PORT || 3002;
const host = '0.0.0.0';

app.listen(port, host, () => {
  logger.info(
    { port },
    `API ERP escuchando en http://localhost:${port} (también http://127.0.0.1:${port})`,
  );
  logger.info(
    {
      usuarios: tables.usuarios,
      locales: tables.locales,
      empresas: tables.empresas,
      productos: tables.productos,
      saleCenters: tables.saleCenters,
      salesCloseOuts: tables.salesCloseOuts,
      mantenimiento: tables.mantenimiento,
      rolesPermisos: tables.rolesPermisos,
      marketing: tables.marketing,
    },
    'Tablas DynamoDB en uso',
  );
  if (SYNC_CLOSEOUTS_ENABLED) {
    logger.info(
      { intervalMs: SYNC_CLOSEOUTS_INTERVAL_MS, recentDays: SYNC_CLOSEOUTS_RECENT_DAYS },
      `Sincronización cierres Ágora: cada ${SYNC_CLOSEOUTS_INTERVAL_MS / 1000}s (últimos ${SYNC_CLOSEOUTS_RECENT_DAYS} días)`,
    );
    setTimeout(() => runCloseoutsSync(port), 2000);
    setInterval(() => runCloseoutsSync(port), SYNC_CLOSEOUTS_INTERVAL_MS);
  }
  setTimeout(() => checkVencimientosFacturas(port), 5000);
  setInterval(() => checkVencimientosFacturas(port), VENCIMIENTOS_INTERVAL_MS);
  logger.info(
    { intervalMin: VENCIMIENTOS_INTERVAL_MS / 60000 },
    `[vencimientos] Check automático cada ${VENCIMIENTOS_INTERVAL_MS / 60000} min`,
  );

  setTimeout(() => checkAutoSyncs(port), 10000);
  setInterval(() => checkAutoSyncs(port), SYNC_SCHEDULER_INTERVAL_MS);
  logger.info(
    { intervalSec: SYNC_SCHEDULER_INTERVAL_MS / 1000 },
    `[auto-sync] Scheduler activo — revisa cada ${SYNC_SCHEDULER_INTERVAL_MS / 1000}s`,
  );

  setTimeout(() => checkInformeDiario(port), 12000);
  setInterval(() => checkInformeDiario(port), SYNC_SCHEDULER_INTERVAL_MS);
  logger.info(
    { intervalSec: SYNC_SCHEDULER_INTERVAL_MS / 1000 },
    `[informe-diario] Scheduler activo — revisa cada ${SYNC_SCHEDULER_INTERVAL_MS / 1000}s`,
  );
  if (SYNC_SALES_LINES_ENABLED) {
    const salesLinesIntervalMs = 24 * 60 * 60 * 1000;
    setTimeout(() => runSalesLinesSync(port), 18000);
    setInterval(() => runSalesLinesSync(port), salesLinesIntervalMs);
    logger.info(
      { intervalHours: salesLinesIntervalMs / 3600000 },
      '[sales-lines/sync] Job nocturno activo (día anterior de Ágora)',
    );
  }
  if (!process.env.INTERNAL_SYNC_SECRET) {
    logger.warn(
      '[api] INTERNAL_SYNC_SECRET no definido: los jobs internos (auto-sync Ágora, cierres, vencimientos) devolverán 401. Añádelo en api/.env.local',
    );
  }
});
