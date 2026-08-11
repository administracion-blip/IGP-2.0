# Remediación de seguridad — 2026-08-11

Rama: `security/remediacion-2026-08`

## Hecho

### S-01 · Facturación (`api/routes/facturacion.js`)
- Todas las rutas exigen `requirePermission` / `requireAnyPermission` alineados con el front.
- Decisiones confirmadas: rectificar→`emitir`; email→`editar`; GET pagos→`ver`; next-number→`series|crear|emitir`.
- Jobs vencimientos/recordatorios: `facturacion.editar` + bypass `isInternal`.

### S-04 · Remesa ejecutar
- Reclamo atómico antes de pagar; 409 si carrera; pagos idempotentes por línea.
- Tests: `api/tests/remesaEjecutar.test.mjs`.

### S-07 · JWT
- HS256 fijado en sign/verify.

### S-02 · Empresas
- `ver` / `crear` / `editar`; DELETE solo Administrador; check-cif → `ver|crear|editar`.

### S-05 · Usuarios
- `usuarios.ver|crear|editar|borrar` (alineado al front).

### S-03 · Acuerdos
- Lecturas → `acuerdos.ver`; crear/editar/borrar según acción; informe → `ver|exportar`.
- Presign: allowlist MIME, `basename` sanitizado, key controlada por servidor.

### S-06 · Uploads facturación
- `api/lib/uploadAllowlist.js`: allowlist + magic bytes + sanitize nombre.
- Multer `fileFilter`; OCR/adjuntos/recibo validan buffer.
- Tests: `api/tests/uploadAllowlist.test.mjs`.

### S-12 · Errores en producción
- 5xx en prod → mensaje genérico + `errorId` (detalle solo en pino).
- 4xx de negocio sin cambio.

### S-15 · CORS producción
- Sin `CORS_ALLOWED_ORIGINS` en prod → aborta arranque.
- Dev: localhost + env opcional.

## Commits
1. `[S-01]` facturación permisos  
2. `[S-04]` remesa atómica  
3. `[S-07]` JWT HS256  
4. `[S-02]` empresas  
5. `[S-05]` usuarios  
6. docs remediación  
7. `[S-03]` acuerdos  
8. `[S-06]` uploads  
9. `[S-12]` errorHandler  
10. `[S-15]` CORS prod  

## Verificación
- `cd api && npm test` → **160 pass / 0 fail**.
- Smoke manual recomendado: ver sección anterior + OCR registro-masivo (PDF/JPG reales) + acuerdos subir justificante.

## Pendiente

| ID | Qué | Nota |
|----|-----|------|
| S-08 | Filtro Locales en facturación | Confirmar: `Locales` vacío = acceso global |
| S-09 | SecureStore vs AsyncStorage | Plan cliente |
| S-10 | Passwords plaintext | Migración gradual |
| S-11 | Helmet CSP report-only | Validar web Expo |
| S-13 | IP allowlist internal-secret | Env opcional |
| S-14 | npm audit fix no rupturista | Revisar majors a mano |

## Roles a revisar
1. DELETE empresas = solo Admin (no hay `empresas.borrar`).
2. Usuarios: mutaciones por permiso (no solo Admin) — alineado al front.
3. Roles de facturación/acuerdos deben tener en Dynamo los mismos códigos que ya usa el menú.

## No-rotura
- `isInternal` intacto; contratos de respuesta estables; Administrador bypassa permisos.
