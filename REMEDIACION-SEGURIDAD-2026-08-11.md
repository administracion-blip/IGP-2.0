# Remediación de seguridad — 2026-08-11

Rama: `security/remediacion-2026-08`

## Hecho en esta tanda

### S-01 · Facturación (`api/routes/facturacion.js`)
- Todas las rutas exigen `requirePermission` / `requireAnyPermission` alineados con el front.
- Decisiones confirmadas:
  - Rectificar → `facturacion.emitir`
  - Enviar email → `facturacion.editar`
  - GET pagos de factura → `facturacion.ver`
  - `series/next-number` → `series` | `crear` | `emitir`
- Jobs `check-vencimientos` / `enviar-recordatorios`: permiso `facturacion.editar` + bypass `isInternal` intacto.
- Comentarios `// [SEC S-01]`.

### S-04 · Remesa ejecutar (`api/routes/remesas.js` + `registrarPago.js`)
- Reclamo atómico `UpdateCommand` + `ConditionExpression` (`Generada`|`Borrador` → `Ejecutada`) **antes** de pagar.
- Segundo intento concurrente → 409.
- Pagos con `idempotencyKey: remesa:{remesaId}:{id_factura}` (no duplican).
- Tests: `api/tests/remesaEjecutar.test.mjs` (4 casos).

### S-07 · JWT (`api/lib/jwt.js`)
- `algorithm: 'HS256'` en sign; `algorithms: ['HS256']` en verify.

### S-02 · Empresas (`api/routes/empresas.js`)
- GET → `empresas.ver`
- check-cif → `ver|crear|editar`
- POST → `empresas.crear`
- PUT → `empresas.editar`
- DELETE → `requireRole('Administrador')` (no existe `empresas.borrar` en catálogo)

### S-05 · Usuarios (`api/routes/usuarios.js`)
- GET/POST/PUT/DELETE → `usuarios.ver|crear|editar|borrar` (alineado con front; deja de exigir solo Administrador en mutaciones).

## Commits
1. `fix(sec): [S-01] exigir permisos en rutas de facturacion`
2. `fix(sec): [S-04] ejecucion de remesa atomica e idempotente`
3. `fix(sec): [S-07] fijar algoritmo HS256 en JWT`
4. `fix(sec): [S-02] permisos en rutas de empresas`
5. `fix(sec): [S-05] permisos en rutas de usuarios`

## Verificación
- `cd api && npm test` → **156 pass / 0 fail** (incluye remesaEjecutar).
- Arranque API: no verificado en esta sesión (recomendado: `npm run dev` en `api/` y smoke manual).

### Smoke manual sugerido
1. Usuario con `facturacion.ver` (sin cobrar_pagar): listar facturas OK; Pagar → 403.
2. Usuario con `facturacion.cobrar_pagar`: registrar pago OK.
3. Registro masivo OCR: requiere `facturacion.crear`.
4. Remesa: ejecutar una vez OK; segundo clic → 409 sin doble pago.
5. Empresas: sin `empresas.ver` → 403 en GET.
6. Usuarios: sin `usuarios.ver` → 403 en listado.

## Pendiente (no aplicado — riesgo / alcance)

| ID | Qué | Por qué pendiente |
|----|-----|-------------------|
| S-03 | Acuerdos + sanitizar presign S3 | Módulo grande; mapear `acuerdos.ver/crear/editar/borrar/exportar` (no hay `gestionar`) |
| S-06 | fileFilter + magic bytes OCR | Bajo riesgo de rotura OCR si MIME real ≠ declarado; conviene probar registro-masivo |
| S-08 | Filtro Locales en facturación | **Antes de filtrar:** roles de grupo sin `Locales` deben seguir viendo todo; confirmar modelo JWT `Locales` vacío = global |
| S-09 | SecureStore vs AsyncStorage | Cambio cliente multiplataforma; plan aparte |
| S-10 | Retirar passwords plaintext | Migración gradual; no cortar login |
| S-11 | Helmet CSP | Empezar report-only; validar web Expo |
| S-12 | Errores genéricos en prod | Barrido de muchos `err.message` en handlers |
| S-13 | IP allowlist internal-secret | Documentar + env opcional |
| S-14 | npm audit fix | Solo fixes no rupturistas; listar majors a parte |
| S-15 | CORS prod obligatorio | Exigir `CORS_ALLOWED_ORIGINS` en producción |

## Roles / permisos a revisar (no asignados a ciegas)

1. **DELETE empresas** queda solo para **Administrador**. Si algún rol no-admin borraba empresas desde UI, dejará de poder (el front tampoco tiene `empresas.borrar`). Confirmar que nadie legítimo depende de borrar empresas sin ser Admin.
2. **Usuarios mutaciones** ahora aceptan `usuarios.crear/editar/borrar` sin ser Admin. Si en Dynamo solo Admin tenía esos códigos, comportamiento igual. Si algún rol tiene `usuarios.crear` en UI, ahora el API también lo permitirá (antes solo Admin → posible **ampliación** intencionada alineada al front).
3. Tras desplegar S-01: cualquier rol que use facturación **debe** tener en `Igp_RolesPermisos` los códigos que ya usa el menú (`facturacion.ver`, etc.). Si un rol veía la pantalla pero el permiso no estaba en Dynamo, el front ya fallaba en botones; si llamaba API directa, ahora 403. Revisar roles operativos de contabilidad/tesorería.

## Notas de no-rotura
- `req.isInternal` / `x-internal-secret` no se ha tocado.
- Contratos de respuesta de APIs no cambiados (salvo 403 nuevos y 409 más estricto en remesa).
- Administrador sigue bypasseando permisos.
