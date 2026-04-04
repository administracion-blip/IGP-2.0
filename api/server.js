import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.local') });
dotenv.config({ path: join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { tables } from './lib/db.js';
import { ensureComprasGSI } from './lib/dynamo/comprasProveedor.js';
import {
  runCloseoutsSync,
  checkAutoSyncs,
  checkVencimientosFacturas,
  SYNC_CLOSEOUTS_ENABLED,
  SYNC_CLOSEOUTS_INTERVAL_MS,
  SYNC_CLOSEOUTS_RECENT_DAYS,
  SYNC_SCHEDULER_INTERVAL_MS,
  VENCIMIENTOS_INTERVAL_MS,
} from './lib/jobs/scheduledTasks.js';
import facturacionRouter from './routes/facturacion.js';
import artistasActuacionesRouter from './routes/artistasActuaciones.js';
import arqueosRealesRouter from './routes/arqueosReales.js';
import mysteryGuestRouter from './routes/mysteryGuest.js';
import personalRouter from './routes/personal.js';
import authRouter from './routes/auth.js';
import usuariosRouter from './routes/usuarios.js';
import productosRouter from './routes/productos.js';
import almacenesRouter from './routes/almacenes.js';
import localesRouter from './routes/locales.js';
import empresasRouter from './routes/empresas.js';
import permisosRouter from './routes/permisos.js';
import festivosRouter from './routes/festivos.js';
import placesRouter from './routes/places.js';
import pedidosRouter from './routes/pedidos.js';
import mantenimientoRouter from './routes/mantenimiento.js';
import agoraRouter from './routes/agora.js';
import acuerdosRouter from './routes/acuerdos.js';
import ajustesRouter from './routes/ajustes.js';

const app = express();

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

app.use('/api', agoraRouter);
ensureComprasGSI();
app.use('/api', acuerdosRouter);

app.use('/api', authRouter);
app.use('/api', usuariosRouter);
app.use('/api', productosRouter);
app.use('/api', almacenesRouter);
app.use('/api', localesRouter);
app.use('/api', empresasRouter);
app.use('/api', permisosRouter);
app.use('/api', festivosRouter);
app.use('/api', placesRouter);
app.use('/api', pedidosRouter);
app.use('/api', mantenimientoRouter);
app.use('/api', facturacionRouter);
app.use('/api', artistasActuacionesRouter);
app.use('/api', arqueosRealesRouter);
app.use('/api', mysteryGuestRouter);
app.use('/api', personalRouter);
app.use('/api', ajustesRouter);

const port = process.env.PORT || 3002;
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log(`API ERP escuchando en http://localhost:${port} (también http://127.0.0.1:${port})`);
  console.log(
    `Tabla usuarios: ${tables.usuarios} | Tabla locales: ${tables.locales} | Tabla empresas: ${tables.empresas} | Tabla productos: ${tables.productos} | Centros venta: ${tables.saleCenters} | Cierres ventas: ${tables.salesCloseOuts} | Mantenimiento: ${tables.mantenimiento} | Roles/permisos: ${tables.rolesPermisos}`,
  );
  if (SYNC_CLOSEOUTS_ENABLED) {
    console.log(`Sincronización cierres Ágora: cada ${SYNC_CLOSEOUTS_INTERVAL_MS / 1000}s (últimos ${SYNC_CLOSEOUTS_RECENT_DAYS} días)`);
    setTimeout(() => runCloseoutsSync(port), 2000);
    setInterval(() => runCloseoutsSync(port), SYNC_CLOSEOUTS_INTERVAL_MS);
  }
  setTimeout(() => checkVencimientosFacturas(port), 5000);
  setInterval(() => checkVencimientosFacturas(port), VENCIMIENTOS_INTERVAL_MS);
  console.log(`[vencimientos] Check automático cada ${VENCIMIENTOS_INTERVAL_MS / 60000} min`);

  setTimeout(() => checkAutoSyncs(port), 10000);
  setInterval(() => checkAutoSyncs(port), SYNC_SCHEDULER_INTERVAL_MS);
  console.log(`[auto-sync] Scheduler activo — revisa cada ${SYNC_SCHEDULER_INTERVAL_MS / 1000}s`);
});
