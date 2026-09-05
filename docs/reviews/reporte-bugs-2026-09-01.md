# Reporte de Revisión de Código — 2026-09-01

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Commits nuevos desde el último reporte (2026-08-24)

| Hash | Fecha | Descripción principal |
|------|-------|----------------------|
| `3867a2a` | 25.08 | Exceso de pago, similares incidencia, OCR factura, VentasPorArticulo IA |
| `0608d77` | 25.08 | Docs módulo Tasks, refactor informes-ia, VistaVentasPorArticulo |
| `3e9b5e1` | 25.08 | **Módulo Tasks completo** (proyectos, tareas, reuniones, adjuntos, enlaces, avisos, departamentos) |
| `519ec84` | 27.08 | CalendarioMisTareas, ModalVistazoProyecto |
| `f31cabe` | 27.08 | Notificaciones, vencimientos ICS, CalendarioInicio, CampanaNotificaciones |
| `796c2eb` | 27.08 | Pipeline audio reuniones, transcripción AWS, propuestas, resumen acta |
| `0c0b3bd` | 31.08 | ImportarTranscripción reuniones, refinado frontend reuniones/proyectos |

Es la semana de mayor volumen del proyecto: ~15 000 líneas nuevas en backend y frontend. La calidad general de la arquitectura es alta (permisos declarados, ACL de fila, tests), pero la densidad del cambio trae varios problemas nuevos.

---

## BUGS NUEVOS

### 1. `SeccionAudioReunion.tsx` — setState tras unmount en subida web
**Archivo:** `app/components/tasks/SeccionAudioReunion.tsx` (~línea 200)  
**Severidad:** Alta

El flujo web crea un `<input type="file">` de forma programática. Cuando el usuario selecciona un archivo, el `onchange` llama `setSubiendo(true)` y encadena `subirAudio(pendiente)` — un proceso de 3 peticiones que puede durar varios minutos para audios grandes. El `.finally()` llama `setSubiendo(false)` y `setFaseSubida(null)`, pero no hay ninguna verificación de que el componente siga montado.

Si el usuario navega a otra pantalla durante la subida, el unmount no cancela el upload, y cuando termine el `.finally()` se ejecutará sobre un componente ya desmontado, generando el warning de React "Can't perform a React state update on an unmounted component" y potencialmente errores en prod.

```tsx
// onchange del <input> — sin montadoRef ni AbortController
void subirAudio(pendiente)
  .catch((e) => { setError(...) })    // ← puede ejecutar tras unmount
  .finally(() => {
    setSubiendo(false);               // ← ídem
    setFaseSubida(null);              // ← ídem
  });
```

**Corrección sugerida:** añadir un `montadoRef` idéntico al que usa `CampanaNotificaciones`, y guardarlo en un `ref` con `useRef(true)` + cleanup en `useEffect`. Adicionalmente, guardar el objeto `File` elegido en estado y cancelar la subida S3 en el cleanup sería la solución completa.

---

### 2. `notificaciones.js` — `marcarLeidas` sin cota en `ids` y con Updates secuenciales
**Archivo:** `api/lib/tasks/notificaciones.js` (línea 264)  
**Severidad:** Media-Alta

Dos problemas en `marcarLeidas`:

**2a — Sin límite en el array `ids`:** El endpoint `POST /api/notificaciones/leer` acepta `body.ids` sin validar su longitud. Un cliente malicioso puede enviar miles de IDs, desencadenando una query completa de la partición del usuario (si son UUIDs) seguida de N `UpdateCommand` individuales.

**2b — Updates secuenciales:** El bucle `for (const key of unicas)` hace un `await` por cada notificación. Con 100 notificaciones son 100 RTTs a DynamoDB en serie. La primitiva correcta es `BatchWriteItem` (chunks de 25) o al menos `Promise.allSettled` con un pool limitado (p. ej. 10 en paralelo).

```js
// tal como está:
for (const key of unicas) {
  await docClient.send(new UpdateCommand({ ... }));  // secuencial
}
```

**Corrección sugerida:** (a) cap de `ids` a 100 (mismo que `LIMITE_LISTA`), (b) agrupar los updates en lotes de 25 con `BatchWriteItem` o paralelizar con `p-limit`.

---

### 3. `vencimientosIcs.js` — comparación de hash sin tiempo constante
**Archivo:** `api/lib/tasks/vencimientosIcs.js` (línea 99)  
**Severidad:** Media

La validación del token ICS compara hashes con `!==`:

```js
if (!item || texto(item.token_hash) !== hashTokenIcs(bruto)) {
  return { ok: false, error: 'Token no válido' };
}
```

Aunque el atacante necesita conocer el `id_usuario` como prefijo (lo que limita bastante la superficie), la comparación de secretos derivados debería ser siempre en tiempo constante para no filtrar información por latencia.

**Corrección sugerida:**
```js
import { timingSafeEqual } from 'node:crypto';
const a = Buffer.from(texto(item.token_hash), 'hex');
const b = Buffer.from(hashTokenIcs(bruto), 'hex');
if (a.length !== b.length || !timingSafeEqual(a, b)) { ... }
```

---

## MÁRGENES DE MEJORA (no son bugs, pero conviene anotar)

### M-1. `CalendarioInicio.tsx` — componente de 1 057 líneas
**Archivo:** `app/components/CalendarioInicio.tsx`

Creado en f31cabe de una vez. Acumula lógica de calendario, fetch de eventos, estado local complejo y renderizado. La proporción de efectos secundarios en un solo componente lo hará difícil de testear y de mantener cuando lleguen cambios de diseño. Candidato a split en: un hook `useCalendarioEventos`, un sub-componente `DiaCelda` y el componente raíz.

### M-2. Módulo Tasks — ausencia de tests de integración end-to-end
Los commits 3e9b5e1 / 796c2eb incluyen cobertura unitaria excelente de las capas de lógica (`tasksProyectos.test.mjs`, `tasksReuniones.test.mjs`, etc.), pero los routers `proyectos.js`, `tareas.js` y `reuniones.js` no tienen tests de ruta (supertest). Un error de wiring de middleware (p. ej. un `requirePermission` mal colocado, como ya ocurrió en cuadrante.js) no lo detectaría ningún test existente.

### M-3. `reuniones/pipelineTick.js` — sin timeout global de ejecución
El tick del pipeline itera sobre todas las reuniones en estado `procesando` y puede lanzar jobs costosos (STT, resumen). No hay un `AbortSignal` ni un timeout máximo de ejecución. Si el scheduler falla, el intervalo siguiente arrancará un tick nuevo sin saber que el anterior sigue vivo.

---

## BUGS CRÍTICOS PERSISTENTES (sin corregir desde reportes anteriores)

| Ref | Archivo | Descripción | Sin corregir desde |
|-----|---------|-------------|-------------------|
| P-1 | `cuadrante.js:38` | `GET /personal/cuadrante` sin `requirePermission` ni filtro de locales | 2026-08-10 |
| P-2 | `facturacion.js:670` | `PUT /facturacion/facturas/:id` — auditoría usa `body.usuario_id` | 2026-08-10 |
| P-3 | `facturacion.js` (8 líneas) | Otras 8 rutas con `body.usuario_id` en auditoría | 2026-08-10 |
| P-4 | `marketing.js:~1274` | `GET /marketing/imagen-url` — sin validación de pertenencia | 2026-08-10 |
| P-5 | `marketing.js` | `scanAllMarketing()` — cross-local para gestores | 2026-08-10 |
| P-6 | `facturacion.js:281` | `usuarioAuditoria()` — fallback a `body.usuario_nombre` | 2026-08-10 |
| P-7 | `banca.js:213` | `GET /banca/movimientos` — sin validación de pertenencia de cuenta | 2026-08-24 |
| P-8 | `mia.js:164` | `GET /mia/locales-almacenes` — scan global sin filtro de usuario | 2026-08-24 |
| P-9 | `escandallos.js:264` | `GET /escandallos/:id/imagen-url` — sin validación de pertenencia | 2026-08-24 |
| P-10 | `mia.js:288` | `GET /mia/informes/:id` — sin ownership check | 2026-08-24 |
| P-11 | `facturacion.js:1164,1274` | `body.usuario_id` en rutas de pago del commit 21.08 | 2026-08-24 |
| P-12 | `escandallos.js` (5 rutas) | Handlers async sin try/catch | 2026-08-24 |

---

## LO QUE ESTÁ BIEN (módulo Tasks)

- **ACL de fila** (`acceso.js`): lógica de permisos centralizada, bien separada de los routers. El patrón `{ ok, status, error }` es consistente en toda la capa de lógica.
- **Protección SSRF** en `enlaces.js`: validación de esquema, bloqueo de IPs privadas/loopback/metadata, seguimiento de redirecciones con re-validación. Bien hecho.
- **Paginación con cursor opaco** (`paginacion.js`): `decodificarCursor` maneja errores silenciosamente devolviendo `null`; `limiteValido` impone un techo de 200. Correcto.
- **Feed ICS**: token opaco, solo se persiste el hash, el ID de usuario permite un Get O(1). El diseño es sólido (solo falta `timingSafeEqual`, bug #3).
- **Tests de pipeline reuniones**: cobertura amplia de `tasksReunionesPipeline.test.mjs`, `tasksReunionesTranscribeAws.test.mjs`, `tasksReunionesPropuestas.test.mjs`.

---

## RESUMEN EJECUTIVO

| Severidad | Nuevos | Persistentes |
|-----------|--------|--------------|
| Crítico   | 0      | 6 (P-1…P-6)  |
| Alto      | 2 (#1, #2) | 6 (P-7…P-12) |
| Medio     | 1 (#3) | 0            |
| Mejora    | 3 (M-1…M-3) | — |

El módulo Tasks es el mayor añadido de la historia del proyecto y tiene una arquitectura cuidada, pero los 12 bugs persistentes de módulos anteriores siguen sin atención. La deuda más urgente sigue siendo el patrón cross-tenant en banca/mia/escandallos y la suplantación de auditoría en facturación.
