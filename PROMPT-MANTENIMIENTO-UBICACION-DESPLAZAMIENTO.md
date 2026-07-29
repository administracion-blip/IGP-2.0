# Prompt de implementación — Mantenimiento: ubicación de locales en mapa + cálculo de desplazamiento

> Pega este documento como instrucción de trabajo para el agente de código en el repo `ipg2.0`.
> Redactado contra convenciones **verificadas** del repo (julio 2026).

---

## 0. Contexto ya existente (no re-crear)

Verificado en el código actual:

- La tabla `igp_Locales` **ya tiene los campos `lat` y `lng`** (ver `TABLE_LOCALES_ATTRS` en `api/routes/locales.js`). El `PUT /locales` y el `POST /locales` ya los persisten.
- La pantalla `app/(app)/locales.tsx` **ya rellena `lat`/`lng`** a partir de una dirección, usando `GET /api/places/autocomplete` y `GET /api/places/details` (`api/routes/places.js`), con clave `GOOGLE_MAPS_API_KEY` y fallback a Nominatim (OpenStreetMap).
- El modal de valoración de reparaciones es `app/components/mantenimiento/MantenimientoValoracionModal.tsx`: hoy solo tiene líneas de conceptos a cobrar (artículo, cantidad, precio, IVA) y calcula totales. **No recibe el local ni su lat/lng**.

Por tanto, **no hay que añadir un campo nuevo de ubicación ni cambiar el esquema de la tabla**. El trabajo es: (1) un selector de ubicación en mapa para fijar `lat`/`lng` con precisión, y (2) el cálculo automático del desplazamiento en la valoración.

---

## 1. Decisiones de diseño (ya cerradas)

- **Origen del trayecto**: una **base/taller fija** del grupo, configurable en Ajustes (dirección + coordenadas). Única para todo el grupo.
- **Cálculo de distancia**: **por carretera**, con **Google Distance Matrix API** (`mode=driving`), reutilizando `GOOGLE_MAPS_API_KEY`.
- **Tarifa**: **€/km**. Se añade una línea "Desplazamiento" precargada y editable en la valoración.
- **Ida y vuelta**: configurable (`ida_vuelta`, por defecto `true` → se multiplica la distancia por 2).

---

## 2. Convenciones del repo (verificadas)

- **API**: Express ESM en `api/`. Rutas nuevas en el router de mantenimiento existente o en `api/routes/mantenimiento.js`; montaje en `api/server.js`.
- **DynamoDB**: `docClient` y objeto `tables` de `api/lib/db.js`. Ajustes viven en `Igp_Ajustes` (`tables.ajustes`) con patrón `PK` de dominio + `SK` de sección (ver uso en `api/lib/jobs/scheduledTasks.js`: PK `sincronizaciones`, `informes`, etc.).
- **Google**: patrón de llamada ya usado en `api/routes/places.js` (`fetch` directo a `maps.googleapis.com`, clave `GOOGLE_MAPS_API_KEY`, `language=es`).
- **Permisos**: middleware `requirePermission(cod)` / `hasPermission(user, cod)` de `api/middleware/auth.js`. Usar el permiso de gestión de mantenimiento ya existente para configurar la base y la tarifa.
- **Frontend**: Expo Router (`.tsx`) bajo `app/(app)/`. `apiFetch` de `app/utils/api.ts`, `useBreakpoint()`, `MaterialIcons`. Para componentes con implementación distinta en web y móvil, seguir el patrón `.web.tsx` / `.native.tsx` ya usado en `app/components/signature/SignaturePad.*.tsx`.
- Texto visible en español; comentarios de cabecera en español explicando el porqué.

---

## 3. Configuración en Ajustes

Guardar en `Igp_Ajustes`, `PK = 'mantenimiento'`, `SK = 'desplazamiento'`:

- `base_direccion` (texto), `base_lat`, `base_lng` (números).
- `precio_km` (€/km, número).
- `ida_vuelta` (bool, default `true`).
- `iva_desplazamiento` (default `21`).
- `auto_anadir` (bool, default `true`): si la línea de desplazamiento se precarga sola en la valoración.

Endpoints:
- `GET /api/mantenimiento/ajustes/desplazamiento` — lee la config. Permiso: ver mantenimiento.
- `PUT /api/mantenimiento/ajustes/desplazamiento` — guarda la config. Permiso: gestionar mantenimiento.

La base se fija con el **mismo selector de mapa** del punto 5 (reutilizar el componente).

---

## 4. Backend: cálculo de desplazamiento

Nuevo endpoint `GET /api/mantenimiento/desplazamiento?localId=<id>` (permiso: ver mantenimiento):

1. Lee la config `mantenimiento/desplazamiento`. Si falta base o `precio_km`, responde `{ configurado: false }` con un motivo claro (no romper la valoración).
2. Lee el local (`GetCommand` sobre `tables.locales`, `Key: { id_Locales }`) y sus `lat`/`lng`. Si el local no tiene coordenadas, responde `{ disponible: false, motivo: 'local_sin_coordenadas' }`.
3. Llama a **Google Distance Matrix**: `https://maps.googleapis.com/maps/api/distancematrix/json?origins=<base_lat>,<base_lng>&destinations=<lat>,<lng>&mode=driving&language=es&key=<GOOGLE_MAPS_API_KEY>`.
   - Extrae `distance.value` (metros) y `duration.value` (segundos) de `rows[0].elements[0]` si `status === 'OK'`.
   - `km = distance.value / 1000`, aplicando `× 2` si `ida_vuelta`.
   - `importe = round2(km * precio_km)`.
4. Devuelve: `{ disponible: true, distancia_km, duracion_min, ida_vuelta, precio_km, importe, iva: iva_desplazamiento }`.
5. **Fallback**: si Google falla o la clave no tiene habilitada Distance Matrix, calcular **Haversine** (línea recta) como aproximación y marcar `{ aproximado: true }` para avisar en la UI. Nunca dejar la valoración sin poder guardarse.

### Caché (recomendado, ahorra coste y latencia)
La distancia base→local es prácticamente estática. Al guardar un local con coordenadas (o al cambiar la base), calcular y **persistir en el local** `desplazamiento_km` y `desplazamiento_min`. El endpoint devuelve el valor cacheado y solo recalcula si cambian las coordenadas del local o la base. Añadir estos dos atributos a `TABLE_LOCALES_ATTRS` en `api/routes/locales.js` (no rompen nada; se listan para no machacarlos en el `PUT`).

> Coste Google si no se cachea: Distance Matrix ≈ 5 USD / 1000 consultas = 0,005 USD por cálculo. Con caché, casi cero.

---

## 5. Frontend: selector de ubicación en mapa

Componente nuevo `app/components/SelectorUbicacionMapa` con implementación por plataforma:

- **Web (`.web.tsx`)**: cargar el JS de Google Maps (Maps JavaScript API) con `GOOGLE_MAPS_API_KEY`; mostrar el mapa con un **marcador arrastrable**; permitir además hacer clic en el mapa para recolocar el pin y una caja de búsqueda (Places Autocomplete) para centrar. Al mover el pin, emitir `onChange({ lat, lng })`.
- **Native (`.native.tsx`)**: `react-native-maps` con `<Marker draggable>` y `onDragEnd`. (Añadir la dependencia si no está; requiere config de `react-native-maps` en `app.json`.)
- Props: `{ lat, lng, onChange, altura? }`. Sin coordenadas iniciales, centrar en un punto por defecto (p. ej. la base o una ciudad del grupo).

### Integración en Locales (`app/(app)/locales.tsx`)
En el modal de alta/edición, junto a los campos `lat`/`lng` actuales, añadir el mapa:
- El autocompletado de dirección que ya existe centra el mapa y coloca el pin.
- Arrastrar el pin ajusta `lat`/`lng` finos (los inputs numéricos pasan a solo lectura o quedan como respaldo).
- Al guardar, `lat`/`lng` viajan en el `PUT /locales` como ya hacen hoy.

### Integración en la valoración (`MantenimientoValoracionModal.tsx`)
El modal **hoy no recibe el local**. Cambios:
1. Añadir a `Props` el local o su id + coordenadas (p. ej. `local?: { id_Locales, lat, lng }`), y pasarlo desde el componente padre que abre el modal (ver `abiertas.tsx` / `MantenimientoIncidenciaDetalleModal.tsx`).
2. Al abrir, si hay local con coordenadas, llamar a `GET /api/mantenimiento/desplazamiento?localId=...`.
3. Mostrar un bloque "Desplazamiento" con distancia (km), tiempo estimado y, si `auto_anadir`, **una línea precargada y editable** con `articulo: 'Desplazamiento'`, `cantidad: km` (o 1), `precio: importe`, `tipo_iva: iva_desplazamiento`. Debe integrarse en el cálculo de totales existente.
4. Si `aproximado`, mostrar aviso ("distancia estimada en línea recta"). Si `disponible: false`, mostrar por qué (local sin ubicación) con enlace a completarla.

---

## 6. Configuración de la clave Google (requisito operativo)

`GOOGLE_MAPS_API_KEY` hoy se usa solo para Places. Para esto hay que **habilitar en el proyecto de Google Cloud** además: **Distance Matrix API** y **Maps JavaScript API**. Revisar las restricciones de la clave (por referrer para web, por IP para el backend) — puede que convenga **una clave de navegador (front) y otra de servidor (Distance Matrix)** para restringir bien. Documentarlo en el README del módulo. Todo tiene fallback a Nominatim/Haversine si la clave no está disponible.

---

## 7. Permisos y variables de entorno

- Permisos: reutilizar los de mantenimiento (ver / gestionar). No hacen falta nuevos.
- Env: `GOOGLE_MAPS_API_KEY` (ya existe). Opcional `GOOGLE_MAPS_BROWSER_KEY` si se separa la clave del front.

---

## 8. Plan por fases

1. **Ajustes de desplazamiento**: tabla `Igp_Ajustes` (`mantenimiento`/`desplazamiento`), endpoints GET/PUT, pantalla de configuración (base con mapa + €/km + ida/vuelta + IVA).
2. **Selector de mapa**: componente `SelectorUbicacionMapa` (web + native) e integración en el modal de Locales.
3. **Cálculo backend**: endpoint `/desplazamiento` con Distance Matrix + fallback Haversine + caché en el local.
4. **Integración en valoración**: pasar el local al modal, precargar la línea de desplazamiento, integrarla en totales.

---

## 9. Criterios de aceptación

- [ ] Se puede fijar la ubicación de un local arrastrando un pin en un mapa; `lat`/`lng` se guardan.
- [ ] Existe una base/taller configurable (dirección + coordenadas) y una tarifa €/km.
- [ ] Al valorar una reparación de un local con ubicación, aparece automáticamente la distancia por carretera, el tiempo y una línea de desplazamiento con el importe correcto (× 2 si ida y vuelta), editable.
- [ ] Si el local no tiene ubicación o Google falla, la valoración sigue funcionando (aviso claro y/o distancia aproximada), nunca se bloquea el guardado.
- [ ] La distancia se cachea y no se llama a Google en cada apertura del modal.
- [ ] La clave de Google tiene habilitadas Distance Matrix y Maps JavaScript API; restricciones documentadas.
```
