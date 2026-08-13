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

### S-08 · Filtro por empresas/Locales en facturación
- `empresasPermitidasDelUsuario` + `facturaEmisorPermitido` en `api/lib/usuarioLocales.js`.
- JWT no lleva Locales: se recargan de DB por email.
- Filtro por **`emisor_id`** (sociedad del grupo), no por `empresa_id` del tercero.
- Admin o `Locales: []` → sin restricción (contabilidad/tesorería).
- Usuario con Locales acotados → solo facturas cuyo emisor esté ligado a esos locales.
- Tests: `api/tests/usuarioLocalesEmpresas.test.mjs`.

### S-13 · Allowlist IP opcional (internal-secret)
- Env `INTERNAL_SYNC_IP_ALLOWLIST` (CSV de IPs).
- Vacía/ausente → solo secret (comportamiento anterior).
- Definida → además la IP del cliente debe estar en la lista (`req.ip`, strip `::ffff:`).

### S-14 · npm audit fix (api/)
- `npm audit fix` sin `--force` en `api/`: 15 → 3 vulnerabilidades.
- Detalle: `api/AUDIT-SEC-S14.md`.
- Raíz: no aplicado (ERESOLVE peers); no `--force`.

### S-11 · Helmet CSP report-only
- `api/lib/helmetOptions.js`: CSP API JSON restrictiva en **Report-Only** (`default-src`/`frame-ancestors`/`base-uri`/`form-action` `'none'`).
- Sin CSP enforcing; COEP sigue `false`.
- No aplica al documento Expo web (otro origen); CSP del front = follow-up de hosting.
- Sin `report-uri` en esta pasada.
- Tests: `api/tests/helmetCsp.test.mjs`.

### S-10 · Passwords (migración gradual)
- Helper `api/lib/password.js`: `hashPassword` / `verifyPassword` (bcrypt + legacy timing-safe).
- Login: bcrypt o plaintext legacy; si legacy OK → rehash on-login con `UpdateCommand` (best-effort).
- Create/update usuarios y reset: siempre bcrypt.
- **Sin** deadline que rechace plaintext (quitar fallback solo tras audit ~0 residuales).
- Script ops: `api/scripts/audit-plaintext-passwords.js` (lista id+email, nunca Password).
- Tests: `api/tests/authPassword.test.mjs`.

### S-09 · SecureStore (JWT cliente)
- `app/utils/authToken.ts`: iOS/Android → `expo-secure-store`; web → AsyncStorage.
- Migración one-shot desde AsyncStorage sin perder sesión; fallback si SecureStore falla.
- `erp_user` sigue en AsyncStorage (fuera de alcance).
- Riesgo residual web (XSS / localStorage) documentado; sin sessionStorage.

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
11. `[S-08]` filtro emisor/Locales facturación  
12. `[S-13]` IP allowlist internal-secret  
13. `[S-14]` npm audit fix api  
14. `[S-11]` CSP report-only Helmet  
15. `[S-10]` passwords helper + rehash Update + audit  
16. `[S-09]` SecureStore JWT nativo  

## Verificación
- `cd api && npm test` → **172 pass / 0 fail**.

## Smoke checklist

Marca al probar. Auto = comprobado en máquina de desarrollo (2026-08-11).

### A · Automatizado / cabeceras
- [x] **A1** `cd api && npm test` → 172 pass / 0 fail
- [x] **A2** `GET /api/health` lleva `Content-Security-Policy-Report-Only` con `default-src 'none'` (S-11)
- [x] **A3** Misma respuesta **no** lleva `Content-Security-Policy` enforcing (S-11)
- [x] **A4** CORS dev: origen `http://localhost:8084` aceptado (visible en logs / OPTIONS 204)

### B · Auth y sesión
- [ ] **B1** Login Admin → home carga; `/api/me` OK (S-07 JWT)
- [ ] **B2** Web: F5 tras login → sigue sesión (S-09 AsyncStorage)
- [ ] **B3** Logout → token limpio; siguiente navegación pide login
- [ ] **B4** (Nativo) Login → matar app → reabrir con sesión (S-09 SecureStore)
- [ ] **B5** (Opcional) Usuario con password plaintext legacy → login OK; en Dynamo `Password` pasa a `$2b$…` (S-10)
- [ ] **B6** (Ops) `node api/scripts/audit-plaintext-passwords.js` → anotar cuántos residuales

### C · Permisos (usuario NO Admin, sin el permiso)
- [ ] **C1** Sin `facturacion.ver` → API facturas 403; menú oculto (S-01)
- [ ] **C2** Sin `empresas.editar` → PUT empresa 403 (S-02)
- [ ] **C3** Sin `usuarios.crear` → POST usuario 403 (S-05)
- [ ] **C4** Sin `acuerdos.ver` → listado acuerdos 403 (S-03)
- [ ] **C5** DELETE empresa solo Admin → otro rol 403 aunque tenga editar (S-02)

### D · Facturación / Locales (S-08)
- [ ] **D1** Admin (o `Locales: []`) → ve facturas de todos los emisores del grupo
- [ ] **D2** Usuario con Locales de **un** local → solo facturas cuyo `emisor_id` es empresa de ese local
- [ ] **D3** Mismo usuario → no abre/edita por ID una factura de otro emisor (403/404 según ruta)
- [ ] **D4** Contabilidad con `Locales: []` → sigue viendo todo (no romper tesorería)

### E · Remesas (S-04)
- [ ] **E1** Ejecutar remesa una vez → pagos OK, estado coherente
- [ ] **E2** Re-ejecutar misma remesa → no doble pago (idempotente / 409 carrera)
- [ ] **E3** Dos clics rápidos → como máximo una ejecución efectiva

### F · Uploads / OCR (S-06)
- [ ] **F1** Registro masivo: PDF real → OCR extrae OK
- [ ] **F2** JPG/PNG real → OK
- [ ] **F3** Fichero no permitido (p. ej. `.exe` / MIME raro) → rechazado
- [ ] **F4** Preview PNG OCR se ve en pantalla (CORP cross-origin en esa ruta)

### G · Acuerdos (S-03)
- [ ] **G1** Listar / ver acuerdo con permiso
- [ ] **G2** Subir justificante (MIME allowlist) OK
- [ ] **G3** Nombre raro / path traversal en filename → sanitizado, no rompe

### H · Errores y prod (S-12 / S-15) — solo si puedes simular prod
- [ ] **H1** En prod sin `CORS_ALLOWED_ORIGINS` → API **no arranca**
- [ ] **H2** En prod con origen permitido → front llama API OK
- [ ] **H3** Forzar 500 (ruta de prueba o mock) → cliente ve mensaje genérico + `errorId`, no stack

### I · Internal sync (S-13) — opcional
- [ ] **I1** Sin `INTERNAL_SYNC_IP_ALLOWLIST` → POST interno con secret OK (como antes)
- [ ] **I2** Con allowlist que **no** incluye tu IP → 401 aunque el secret sea correcto

### Criterio de salida
- Obligatorios antes de merge: **A** completo + **B1–B3** + **C1** + **D1–D2** + **E1–E2** + **F1**.
- Resto: recomendado; H en staging/prod.

## Pendiente / follow-ups

| ID | Qué | Nota |
|----|-----|------|
| — | Quitar fallback plaintext | Tras `node api/scripts/audit-plaintext-passwords.js` ≈ 0 |
| — | CSP documento Expo | Hosting/CDN tras `expo export` (fuera del API) |
| — | npm audit raíz | Resolver ERESOLVE peers sin Expo major |
| — | Roles Dynamo | Alinear códigos con menú; DELETE empresas = Admin |

## Roles a revisar
1. DELETE empresas = solo Admin (no hay `empresas.borrar`).
2. Usuarios: mutaciones por permiso (no solo Admin) — alineado al front.
3. Roles de facturación/acuerdos deben tener en Dynamo los mismos códigos que ya usa el menú.
4. Contabilidad/tesorería: `Locales: []` o Administrador (S-08).

## No-rotura
- `isInternal` intacto (allowlist IP solo si se define env); contratos de respuesta estables; Administrador bypassa permisos y filtro de empresas.
