import { verifyToken } from '../lib/jwt.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  try {
    const decoded = verifyToken(header.slice(7));
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.rol === 'Administrador') return next();
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Rol insuficiente para este recurso' });
    }
    next();
  };
}

export function requirePermission(permiso) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.rol === 'Administrador') return next();
    try {
      const result = await docClient.send(new GetCommand({
        TableName: tables.rolesPermisos,
        Key: { PK: `ROL#${req.user.rol}`, SK: `PERMISO#${permiso}` },
      }));
      if (result.Item) return next();
      return res.status(403).json({ error: 'Permiso insuficiente' });
    } catch (err) {
      console.error('[requirePermission]', err.message);
      return res.status(500).json({ error: 'Error verificando permisos' });
    }
  };
}
