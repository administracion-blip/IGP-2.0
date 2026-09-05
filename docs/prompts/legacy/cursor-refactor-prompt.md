# Prompt de Refactoring — ipg2.0
_Actualizado con decisiones reales tomadas durante la ejecución_

---

## Estado del plan

| Fase | Sub-paso | Estado |
|---|---|---|
| 1.1 | Middleware de error central | ✅ completado |
| 1.2 | Logger estructurado (pino) | ✅ completado |
| 1.3 | Validación de env vars | ✅ completado |
| 1.4 | CORS (warning + doc) | ✅ completado |
| 2.1 | Ampliar `apiFetch` (timeout + 401) | ✅ completado |
| 2.2 | Migrar fetch manuales al API | ✅ completado — 3 archivos migrados (ver notas) |
| 3 — Facturación | Tipos + `:any` + split god file | ✅ completado — 5 bugs latentes capturados |
| 3 — Acuerdos | Tipos + `:any` + split god file | ✅ completado — 4 bugs latentes capturados |
| 3 — registro-masivo.tsx | Tipos + `:any` + split god file | ✅ completado — regresión OCR detectada y corregida post-split (ver notas) |
| 3 — personal.tsx | Tipos + `:any` | ✅ completado |
| 3 — Compras (Ciclo 1) | Tipos `app/types/compras.ts` + 30 `:any` en `ComprasProveedorModal.tsx` | ✅ completado |
| 3 — Compras (Ciclo 2) | Hooks + componentes `pedidos.tsx` / `pedidos-completados.tsx` | ⏳ próxima sesión — diagnóstico listo (ver notas) |
| 3 — Barrido dominios pequeños | ajustes (8), productos (4), actuaciones (2), dashboard (2), cajas (1), almacenes (1) | ⏳ pendiente — 18 `:any` totales, sin god files |
| 4.1 | Split god files backend (`agora.js`, `facturacion.js`) | ⏳ pendiente |
| 4.2 — Login | GSI `Email-index` en `igp_usuarios` | ✅ completado — reducción ~50× RCU por login |
| 4.2 — Detalle factura | GSI `id_factura-index` en Lineas/Pagos/Auditoria | ✅ completado |
| 4.2 — Facturas por fecha/local | GSI `Local-Fecha-index` en `Igp_Facturas` | ⏳ pausado (ver notas) |
| 4.2 — Pedidos por estado | GSI `Estado-index` en `Igp_Pedidos` | ⏳ pendiente |

---

## Decisiones y aprendizajes registrados

### Proceso validado para cada dominio frontend

El ciclo **tipos → eliminar `:any` → split del god file** debe hacerse en ese orden y en el mismo ciclo mientras el contexto está cargado. Separar las fases en bloques grandes significa volver a leer y entender cada dominio dos veces. En los dos dominios completados se capturaron 9 bugs latentes en total que el split habría distribuido en archivos separados sin que TypeScript los detectara.

**Bugs latentes encontrados hasta ahora:**
1. `factura-detalle.tsx`: `data.audit_log` → `data.auditoria` — el panel de auditoría nunca se mostraba.
2. `factura-detalle.tsx`: render `entry.fecha` → `formatCreadoEn(entry.timestamp_accion)` — campo inexistente.
3. `cuadro-mando.tsx`: `useState<EmpresaOpt[]>([])` faltante — filtro de empresas roto en runtime.
4. `acuerdos.tsx`: `key={e.CIF || e.Id}` → `key={e.Cif || e.id_empresa}` — campos inexistentes causaban reconciliación rota en el dropdown de marca (ghost values al filtrar).
5. `acuerdos.tsx`: `productoTooltip` muerto — `setProductoTooltip` con valor nunca se llamaba en todo el repo. Eliminado (15 líneas + 2 estados).
6. `acuerdos.tsx`: `onSaved` con tipo de retorno desalineado — side effect mudo.
7. `acuerdos.tsx`: toggle "Realizado" sin manejo de error — PATCH fallido revertía el optimistic update en silencio.
8. `registro-masivo.tsx` (post-split): regresión OCR por timeout — `apiFetch` con default 30 s abortaba extracciones largas de Tesseract. Fix aplicado: `timeoutMs: 120_000` en `/ocr/extraer` y `/ocr/confirmar`, `timeoutMs: 60_000` en `/ocr/enriquecer-ia`. Causa raíz secundaria: helmet 8 establece `Cross-Origin-Resource-Policy: same-origin` por defecto, bloqueando `<img>` cross-origin en zona OCR. Fix aplicado: `res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')` en `/api/facturacion/ocr/preview-png` (sobrescribe el default de helmet sin abrir el resto de rutas).
9. `pedidos-completados.tsx`: `READ_ONLY = true` hardcoded pero sin filtrar por `Estado === 'Completado'` — la pantalla mostraba TODOS los pedidos. Se corregirá en Ciclo Compras-2 con prop `filtroEstado`.

### Reglas de decisión para splits de god files

**Inventario antes de extraer:** siempre hacer un inventario de modales (estado que leen, estado que mutan, qué comparten) antes de decidir los límites de los hooks. El inventario tarda minutos y evita rehacerlo.

**Criterio de granularidad de hooks:** si un hook único necesitaría exponer más de 5-6 propiedades para servir a modales que nunca están activos simultáneamente, son hooks separados. En `acuerdos.tsx` resultó en 3 hooks (`useAcuerdosForm`, `useAcuerdoNotas`, `useAcuerdoPago`) en lugar de un `useAcuerdosForm` único.

**Orden de extracción:** siempre del más encapsulado al más arriesgado. El más encapsulado va primero como warm-up; el que toca el flujo principal de la pantalla va último.

**Código muerto confirmado:** eliminar, no documentar. Si aparece en el inventario que un `useState` nunca se actualiza con valor desde ningún punto del repo (grep), se elimina directamente.

### Fases 1 y 2 — Notas de implementación

**Fase 1.1 (middleware de error):** El middleware no debe tocar:
- Catches internos de loops/Promise.all que acumulan errores en `errors.push({...})` — son lógica de negocio tolerante a fallos parciales (closeouts, sync, lote).
- Endpoints de diagnóstico como `/agora/test-connection` que devuelven `200 { ok: false }` por diseño.
- Endpoints donde `ResourceNotFoundException` es semánticamente 404 aunque el middleware lo mapearía diferente (ej. `ConditionalCheckFailedException` en sale-centers PATCH es 404 "no encontrado", no 409).

**Fase 2.2 (fetch manuales):** Solo se migraron 3 archivos reales:
- `app/lib/personalizacion.ts` → `apiFetch` con `timeoutMs: 8000`
- `app/login.tsx` → `apiFetch` con `timeoutMs: 15000` (mantiene `API_URL` solo para mensajes de error al usuario)
- `app/contexts/AuthContext.tsx` → `apiFetch` con `timeoutMs: 10000` (mantiene la lógica de 401 explícita porque `userRef.current` es null en bootstrap)

Los `fetch(uri)` restantes en el repo son correctos: URIs locales de imagen, presigned URLs de S3, API externa Open-Meteo. No migrar.

### Fase 4.2 — Notas de implementación

**Patrón `ensureXxxGSI`:** cada GSI nuevo sigue el patrón de `api/lib/dynamo/comprasProveedor.js`: función idempotente que detecta el estado del índice al arrancar, lo crea si no existe, usa Scan como fallback mientras está en `CREATING`, y marca `gsiReady` cuando está `ACTIVE`. Esto da zero downtime durante la creación.

**`Igp_Facturas` (fecha/local):** pausado. El PK es `(empresa_id, id_factura)` y los filtros típicos son por `local_id` y `fecha`. El diseño del GSI requiere decidir si `local_id` va como hash key o como sort key compuesto con `fecha`, dependiendo de si los filtros siempre incluyen `local_id`. Analizar los patrones de query reales antes de continuar.

**`FacturasAuditoria`:** GSI con proyección `KEYS_ONLY` si el historial solo muestra fecha + usuario + acción. Para `FacturasLineas` y `FacturasPagos` usar `ALL`.

---

## Siguiente paso recomendado

### Compras — Ciclo 2 (próxima sesión, diagnóstico ya completo)

**Contexto crítico:** `PedidosBase.tsx` (1410 líneas) es **código muerto** — no hay ningún import en todo el repo. Es un intento de abstracción abandonado. `pedidos.tsx` y `pedidos-completados.tsx` son implementaciones paralelas con ~70% de duplicación. Eliminar `PedidosBase.tsx` al final del ciclo.

**Fuente de verdad:** `pedidos.tsx` es el archivo "vivo" con todas las features (permisos, enviarPedido, deeplinks, useFocusEffect, localesOrdenados). `pedidos-completados.tsx` es una copia degradada read-only.

**Helpers ya disponibles en utils/ que ambos archivos reimplementan localmente (eliminar duplicados):**
- `parseAlmacenesOrigen`, `valorEnLocal`, `formatFecha`, `formatCreadoEn`, `fechaToIso`, `formatMoneda`

**Estrategia: Opción B — hooks + componentes compartidos (mismo patrón que acuerdos y registro-masivo)**
1. Extraer desde `pedidos.tsx` (fuente de verdad): `usePedidosData`, `usePedidoForm`, `usePedidoLineas`, `usePedidosPermisos`.
2. Extraer componentes: `<PedidoFormModal>`, `<PedidoBorrarModal>`, `<PedidoLineasPanel>`, `<PedidoLineaFormPanel>`.
3. Aplicar los mismos hooks/componentes a `pedidos-completados.tsx` con prop `readOnly` + añadir filtro `filtroEstado === 'Completado'` (bug latente activo).
4. Eliminar helpers locales duplicados, reemplazar por imports desde `utils/`.
5. Eliminar `PedidosBase.tsx`.

**Resultado esperado:** ~2 500 líneas eliminadas, bug de filtro corregido, 0 cambios funcionales.

### Barrido dominios pequeños (puede hacerse en cualquier momento)
18 `:any` totales sin god files: `ajustes.tsx` (8), `productos.tsx` (4), `actuaciones/index.tsx` (2), `index.tsx` dashboard (2), `cajas/objetivos.tsx` (1), `almacenes.tsx` (1).

---

## Infraestructura y convenciones establecidas

### Frontend (`app/`)
- **`app/utils/api.ts`**: `apiFetch(path, { timeoutMs?, method?, body?, headers? })` — wrapper centralizado con token automático, timeout con AbortController, limpieza de sesión en 401. Usar para todas las llamadas al API backend.
- **`app/utils/api.ts`**: `errorMessage(e: unknown, fallback?: string): string` — extrae mensaje de error de cualquier tipo. Usar en todos los catches de componentes y hooks.
- **`app/types/factura.ts`**: tipos canónicos del dominio facturas. Extender aquí, no crear tipos locales en componentes.
- **`app/types/acuerdo.ts`**: tipos canónicos del dominio acuerdos. Mismo criterio.
- **`app/types/registroMasivo.ts`**: tipos del subdominio registro masivo (Borrador, LineaDesglose, etc.).
- **`app/types/compras.ts`**: tipos canónicos del dominio compras. Hoy contiene `CompraLinea`, `OpcionFiltro`, `FiltroDropdownKey`. Extender en Ciclo Compras-2 con `Pedido`, `Local`, `Almacen`, `LineaPedido` (hoy mal tipados como `Record<string, string | number | undefined>` en `pedidos.tsx` y `pedidos-completados.tsx`).
- **`app/(app)/compras/comprasProveedorShared.tsx`**: re-exporta los tipos desde `app/types/compras.ts` para no romper imports existentes; mantener este atajo mientras haya consumidores.
- **`app/lib/registroMasivo.ts`**: helpers puros del subdominio (mergeReconciliacion, calcularTotalesDesdeDesglose, confColor, etc.).
- **`app/lib/acuerdoNotas.ts`**: helpers puros para el editor de notas de acuerdos (escapeHtml, plainNotasToHtmlForEditor, fechaHoyDmy, etc.).
- **`app/hooks/`**: hooks extraídos — `useCrearEmpresaModal`, `useEmpresasGrupo`, `useZonaOCR` (registro masivo); `useAcuerdosForm`, `useAcuerdoNotas`, `useAcuerdoPago` (acuerdos). Patrón: callbacks `onSaved/onError/onSuccess` para no acoplar el hook al estado del padre.
- **`app/components/registroMasivo/`**: componentes extraídos del god file (estructura en subcarpeta, estilos self-contained).
- **`app/components/`** (nivel raíz): componentes extraídos de acuerdos — `AcuerdoFormModal`, `AcuerdoNotasModal`, `AcuerdoPagoModal`. Y `ComprasProveedorModal` (refactorizado en Ciclo Compras-1 adoptando `CompraLinea`). Estilos self-contained en cada archivo.
- **`apiFetch` timeouts para OCR** — llamadas largas necesitan `timeoutMs` explícito: `/ocr/extraer` → 120 000 ms, `/ocr/enriquecer-ia` → 60 000 ms, `/ocr/confirmar` → 120 000 ms. Sin `timeoutMs` explícito el default (30 s) aborta Tesseract en PDFs complejos. Aplicar el mismo patrón a cualquier endpoint nuevo que llame a Tesseract, OpenAI o haga procesamiento batch en backend.
- **Deuda externa documentada (no tocar):** `router.push({...} as any)` (limitación expo-router), `{ overflow: 'visible' } as any` (limitación RN ViewStyle), `(doc as any).lastAutoTable` (jspdf-autotable sin tipos), `(el as any)._nativeTag` (internal RN), `outlineStyle: 'none' as any` (RN Web StyleSheet typings no exponen outline).

### Backend (`api/`)
- **`api/lib/logger.js`**: instancia pino exportada. Usar `logger.info/warn/error` en lugar de `console.*`.
- **`api/middleware/errorHandler.js`**: middleware de 4 parámetros registrado al final de `server.js`. Los route handlers usan `next(err)` en el catch.
- **`api/lib/validateEnv.js`**: valida `JWT_SECRET`, `AWS_REGION`, `INTERNAL_SYNC_SECRET` al arranque. Variables DDB no incluidas (tienen fallback en `db.js`).
- **`api/lib/dynamo/usuarios.js`**: `findUsuarioByEmail(email)` — Query por GSI `Email-index` con fallback a Scan. Usar en lugar de ScanCommand en auth y scripts.
- **`api/lib/dynamo/facturasRelacionadas.js`**: `queryLineasByFactura`, `queryPagosByFactura`, `queryAuditoriaByFactura` — usan PK directo (no GSI) para detalle de factura.
- **Helmet (`api/server.js:65`)** está activo con `contentSecurityPolicy: false` y `crossOriginEmbedderPolicy: false`. **NO desactiva `crossOriginResourcePolicy`**, por lo que el default es `same-origin`. Cualquier asset que el frontend cargue cross-origin desde el API (imágenes vía `<img>`, scripts, fonts) necesita `res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')` en su ruta. Hoy aplicado solo en `/api/facturacion/ocr/preview-png`. Si aparecen más assets bloqueados, valorar mover a configuración global de helmet (`crossOriginResourcePolicy: { policy: 'cross-origin' }`).
