# Prompt para Cursor: Módulo de Activaciones de Marcas

## Contexto del proyecto

- Framework: React Native / Expo con backend Node.js/Express en `/api`
- Base de datos: DynamoDB
- El módulo de reservas existe hoy como **un único archivo placeholder** (`app/(app)/reservas.tsx`) con contenido mínimo. Se eliminará y se reemplazará por una carpeta con sub-módulos.
- El Planning Diario existe en `app/(app)/planning-dia/index.tsx` y usa el componente `HubTile` con el array `TARJETAS`. Hay que añadirle una tarjeta nueva.
- Patrón de permisos: `hasPermiso('permiso.accion')` desde `useAuth()`
- Patrón visual de referencia: `app/(app)/planning-dia/actuaciones.tsx` para la vista diaria del bar; `app/(app)/compras/almacen.tsx` para listas con chips de filtro y tarjetas.

---

## Modelo de datos

### Tabla `Igp_Activaciones` — ficha maestra de cada activación

Cada documento representa **una campaña de activación** (puede aplicarse a varios locales en distintas fechas).

```
activacionId      (PK, UUID)
codigo            string  — ej. LARIOSPOMELO_RULETA_26HD
marca             string  — ej. "Larios"
producto          string  — ej. "Larios Pomelo"
tipoActivacion    string  — ej. "Ruleta", "Degustación", "Showcooking"
vigenciaInicio    string  — YYYY-MM-DD
vigenciaFin       string  — YYYY-MM-DD
duracionHoras     number  — duración de cada sesión en horas
ocasion           string  — ej. "Tardeo largo / 1ª copa", "Noche"
targetDescripcion string  — ej. "+35 años"
mecanica          string  — descripción libre de cómo funciona la activación
equipoDescripcion string  — ej. "Azafato + Azafato + Coordinador"
materiales        string[] — lista libre, ej. ["Ruleta x2", "Totebags", "Tickets", "Agitadores", "Removedor 150u"]
pagoObservaciones string  — ej. "El PDV debe guardar todos los tickets para liquidación"
empresaId         string  — `id_empresa` de la tabla `igp_Empresas` (denormalizado al guardar)
empresaNombre     string  — `Nombre` de la empresa en el momento de guardar
empresaCif        string  — `Cif` de la empresa en el momento de guardar
promotorNombre    string  — nombre del contacto promotor de la marca
promotorTelefono  string  — teléfono del contacto promotor (formato libre, ej. "+34 612 345 678")
estado            string  — "Borrador" | "Activa" | "Archivada"
creadoPor         string  — userId
```

### Tabla `Igp_ActivacionSesiones` — sesiones programadas por local

Cada documento representa **una sesión concreta** de una activación en un local en una fecha y hora.

```
sesionId          (PK, UUID)
activacionId      (referencia a Igp_Activaciones)
localId           string  — id del local donde se realiza
fecha             string  — YYYY-MM-DD correspondiente a la **jornada** (business day), no al día calendario. Si la sesión empieza a las 23:00 y termina a las 01:00 del día siguiente, `fecha` es el día de inicio (la jornada a la que pertenece).
horaInicio        string  — "HH:mm" (24h)
horaFin           string  — "HH:mm" (24h). Puede ser menor que `horaInicio` si la sesión cruza medianoche (ej. inicio 23:00, fin 01:00). La detección de cruce de medianoche se hace comparando `horaFin < horaInicio`.
estadoSesion      string  — "Programada" | "Realizada" | "Cancelada". **Valor por defecto al crear: "Programada".**
incidencia        string? — texto libre, solo si hubo incidencia (opcional)
creadoPor         string
```

**GSI sugerido en `Igp_ActivacionSesiones`:**
- `localId-fecha-index` con claves `localId` (PK) y `fecha` (SK) → permite obtener todas las sesiones de un local en una jornada dada de forma eficiente (uso principal del Planning Diario).

**Lógica de auto-marcado como "Realizada":**
Cuando el endpoint `GET /api/activaciones/sesiones/dia` devuelve las sesiones del día, antes de responder debe comprobar para cada sesión con `estadoSesion === "Programada"` si la hora de finalización ya ha pasado:
- Construir el datetime de fin: si `horaFin >= horaInicio` → fecha + horaFin; si `horaFin < horaInicio` → fecha + 1 día + horaFin (sesión que cruza medianoche).
- Si ese datetime es anterior al momento actual (`Date.now()`), hacer un `UpdateCommand` automático a `estadoSesion: "Realizada"` antes de incluir el ítem en la respuesta.
- Este auto-marcado es silencioso (no interrumpe la petición del cliente, se hace en paralelo con `Promise.all`).

---

## Tarea 1 — Registrar las tablas en el proyecto

En el archivo donde se definen los nombres de tablas DynamoDB (buscar patrón `process.env.DYNAMODB_TABLE_` o similar en el proyecto), añadir:

```
DYNAMODB_TABLE_ACTIVACIONES
DYNAMODB_TABLE_ACTIVACION_SESIONES
```

---

## Tarea 2 — Crear `api/routes/activaciones.js`

Seguir el patrón de autenticación, manejo de errores y extracción de `localId` del token de `api/routes/almacenes.js` o `api/routes/agora.js`.

### Endpoints de la ficha maestra

**`GET /api/activaciones`**
Lista todas las activaciones. Parámetros query opcionales: `estado` (filtra por Borrador/Activa/Archivada).
Devuelve el array sin las sesiones (solo la ficha).

**`GET /api/activaciones/:activacionId`**
Devuelve la ficha completa de una activación. Sin sesiones.

**`POST /api/activaciones`**
Crea una nueva activación.
- Genera `activacionId` con `crypto.randomUUID()`
- Añade `creadoPor`, `creadoEn`, `actualizadoEn`
- `estado` por defecto: `"Borrador"`
- Requiere permiso `activaciones.gestionar`

**`PATCH /api/activaciones/:activacionId`**
Actualiza campos de la ficha. Actualiza `actualizadoEn`.
- Requiere permiso `activaciones.gestionar`

**`DELETE /api/activaciones/:activacionId`**
Elimina la ficha y todas sus sesiones.
- Requiere permiso `activaciones.gestionar`

### Endpoints de sesiones

**`GET /api/activaciones/:activacionId/sesiones`**
Lista todas las sesiones de una activación.

**`GET /api/activaciones/sesiones/dia`**
Parámetros query: `localId` (obligatorio), `fecha` (YYYY-MM-DD, por defecto hoy).
Usa el GSI `localId-fecha-index` para obtener todas las sesiones de ese local en esa fecha.
Para cada sesión, adjuntar los campos de la ficha maestra correspondiente (al menos: `codigo`, `marca`, `producto`, `tipoActivacion`, `mecanica`, `duracionHoras`, `equipoPax`, `equipoDescripcion`, `materiales`, `premiosDescripcion`).
Devuelve array enriquecido, ordenado por `horaInicio`.
- Requiere permiso `activaciones.ver`

**`POST /api/activaciones/:activacionId/sesiones`**
Crea una o varias sesiones. El body puede ser un objeto único `{ localId, fecha, horaInicio }` o un array de ellos (para programar la misma activación en varios locales o fechas de una vez).
- Genera `sesionId` por sesión con `crypto.randomUUID()`
- `estadoSesion` por defecto: `"Programada"`
- Requiere permiso `activaciones.gestionar`

**`PATCH /api/activaciones/sesiones/:sesionId`**
Actualiza una sesión: permite cambiar `estadoSesion`, `horaInicio`, `fecha` e `incidencia`.
- Para marcar `estadoSesion: "Realizada"` o añadir `incidencia`: requiere permiso `activaciones.ver` (lo puede hacer el bar).
- Para cambiar fecha/hora: requiere permiso `activaciones.gestionar`.

**`DELETE /api/activaciones/sesiones/:sesionId`**
Elimina una sesión.
- Requiere permiso `activaciones.gestionar`

---

## Tarea 3 — Registrar la ruta en `api/index.js`

Importar `activaciones.js` y montar en `/api/activaciones` siguiendo el patrón del resto de rutas.

---

## Tarea 4 — Reestructurar el módulo Reservas

El archivo `app/(app)/reservas.tsx` es un placeholder vacío. Hacer lo siguiente:

1. **Eliminar** `app/(app)/reservas.tsx`
2. **Crear** `app/(app)/reservas/_layout.tsx` con un `Stack` con `headerShown: false` y las siguientes pantallas:
   ```
   index
   cover-manager
   activaciones
   activacion-nueva
   activacion-detalle
   activacion-sesiones
   ```
3. **Crear** `app/(app)/reservas/index.tsx` — hub con dos `HubTile` (mismo componente que usa `planning-dia/index.tsx`):
   - **Cover Manager**: icono `event-available`, ruta `/reservas/cover-manager`, permiso `reservas.ver`, descripción "Gestión de reservas (integración próximamente)"
   - **Activaciones de marca**: icono `celebration`, ruta `/reservas/activaciones`, permiso `activaciones.ver`, descripción "Campañas y activaciones de marcas de bebidas"

4. **Crear** `app/(app)/reservas/cover-manager.tsx` — pantalla de placeholder:
   - Mostrar mensaje: "La integración con Cover Manager estará disponible próximamente."
   - Incluir el icono `schedule` de MaterialIcons y el texto en el estilo del resto de pantallas de placeholder del proyecto.

---

## Tarea 5 — Pantalla de lista de activaciones: `app/(app)/reservas/activaciones.tsx`

Pantalla de gestión para administradores (los que tienen `activaciones.gestionar`). El personal del bar con solo `activaciones.ver` no accede aquí directamente (lo hacen desde el Planning Diario).

**Comportamiento:**
1. Al cargar: `GET /api/activaciones` con filtro de estado.
2. Chips de filtro horizontal: `Activas` | `Borrador` | `Archivadas` | `Todas`
3. Lista de tarjetas, una por activación. Cada tarjeta muestra:
   - Código y nombre de marca/producto en negrita
   - Tipo de activación y vigencia (ej. "Ruleta · 8 may – 1 nov 2026")
   - Badge de estado con color: Borrador=gris, Activa=verde, Archivada=amarillo
   - Icono de sesiones pendientes si tiene sesiones con `estadoSesion: "Programada"`
4. Botón flotante "+" (solo si `activaciones.gestionar`) que navega a `/reservas/activacion-nueva`
5. Al tocar una tarjeta: navegar a `/reservas/activacion-detalle?id=<activacionId>`

---

## Tarea 6 — Formulario de creación/edición: `app/(app)/reservas/activacion-nueva.tsx`

Usable tanto para crear (sin `id` en params) como para editar (con `?id=<activacionId>`).
Requiere permiso `activaciones.gestionar`.

**Campos del formulario** (en este orden, agrupados visualmente con cabecera de sección):

**Sección "Empresa y promotor"**
- Empresa (desplegable de búsqueda, obligatorio): carga la lista desde `GET /api/empresas` (tabla `igp_Empresas`). Mostrar `Nombre` en el desplegable; al seleccionar, guardar en el estado local `empresaId`, `empresaNombre` y `empresaCif`. Mostrar el CIF como texto auxiliar debajo del selector una vez seleccionada. Seguir el patrón de selector buscable que ya exista en el proyecto, o implementar un `Modal` con `TextInput` de búsqueda + lista filtrada si no hay componente reutilizable.
- Nombre del promotor (TextInput) — persona de contacto de la marca
- Teléfono del promotor (TextInput, `keyboardType: 'phone-pad'`) — se usará para abrir WhatsApp

**Sección "Identificación"**
- Código (TextInput, obligatorio) — ej. LARIOSPOMELO_RULETA_26HD
- Marca (TextInput, obligatorio)
- Producto (TextInput, obligatorio)
- Tipo de activación (TextInput) — ej. Ruleta, Degustación

**Sección "Vigencia y sesión"**
- Fecha inicio (DatePicker o TextInput con formato YYYY-MM-DD)
- Fecha fin
- Duración por sesión en horas (TextInput numérico)
- Ocasión (TextInput) — ej. "Tardeo largo / 1ª copa"
- Target de consumidor (TextInput) — ej. "+35 años"

**Sección "Mecánica"**
- Mecánica (TextInput multilínea) — descripción de cómo funciona la activación

**Sección "Equipo"**
- Descripción del equipo (TextInput) — ej. "Azafato + Azafato + Coordinador"

**Sección "Materiales"**
- Lista editable de materiales (texto libre): botón "Añadir material" que abre un TextInput inline. Cada material añadido se muestra como chip con botón de eliminar.

**Sección "Observaciones de pago"**
- Observaciones (TextInput multilínea) — ej. "El PDV debe guardar todos los tickets para liquidación"

**Pie del formulario:**
- Botón "Guardar como borrador" → `POST` o `PATCH` con `estado: "Borrador"`
- Botón "Activar" → `POST` o `PATCH` con `estado: "Activa"` (solo si todos los campos obligatorios están rellenos)

---

## Tarea 7 — Pantalla de detalle y sesiones: `app/(app)/reservas/activacion-detalle.tsx`

Recibe `?id=<activacionId>` por query param.

**Secciones:**
1. **Cabecera**: código, marca, producto, badge de estado, botón editar (→ `activacion-nueva?id=X`) si tiene permiso `activaciones.gestionar`.
2. **Ficha completa**: todos los campos de la activación mostrados en modo lectura (no editable), agrupados en las mismas secciones que el formulario.
3. **Bloque de empresa y contacto**: mostrar `empresaNombre`, `empresaCif`, `promotorNombre` y `promotorTelefono`. Si `promotorTelefono` tiene valor, mostrar dos botones de acción junto al teléfono:
   - **Botón "Llamar"**: `Linking.openURL('tel:' + promotorTelefono)` — igual que ya hace `empresas.tsx`.
   - **Botón "WhatsApp"** (icono de WhatsApp o texto "WA"): abre `Linking.openURL(buildWhatsAppUrl(activacion))` donde `buildWhatsAppUrl` genera la URL `https://wa.me/<telefono_normalizado>?text=<mensaje_preformateado>`.

   **Función `buildWhatsAppUrl(activacion)`:**
   - Normalizar el teléfono: quitar espacios, guiones y paréntesis; si no empieza por `+` asumir prefijo `+34` (España).
   - El mensaje preformateado (URL-encoded) debe incluir:
     ```
     Hola [promotorNombre], te confirmamos la activación:

     📋 Código: [codigo]
     🏷️ Producto: [marca] – [producto]
     🏢 Empresa: [empresaNombre] ([empresaCif])
     📅 Vigencia: [vigenciaInicio] → [vigenciaFin]
     ⏱️ Duración por sesión: [duracionHoras]h
     👥 Equipo: [equipoDescripcion]

     ¿Podéis confirmar disponibilidad?
     ```
   - Este mensaje es un punto de partida; el usuario puede editarlo antes de enviar (WhatsApp abre el chat con el texto prellenado pero no lo envía automáticamente).

4. **Sesiones programadas**: lista de sesiones (`GET /api/activaciones/:id/sesiones`). Cada sesión muestra: local, fecha de jornada, franja horaria (`horaInicio` – `horaFin`), estado (badge de color). Botón "Gestionar sesiones" → navega a `/reservas/activacion-sesiones?id=<activacionId>`.

---

## Tarea 8 — Pantalla de gestión de sesiones: `app/(app)/reservas/activacion-sesiones.tsx`

Recibe `?id=<activacionId>` por query param.
Requiere permiso `activaciones.gestionar`.

**Comportamiento:**
1. Muestra el código y marca de la activación como cabecera.
2. Lista las sesiones existentes agrupadas por local, ordenadas por fecha y hora.
3. Cada sesión muestra: fecha, hora, estado (badge), y si tiene incidencia un icono de advertencia.
4. Botón "Nueva sesión" → abre un modal con:
   - Picker de local (lista de locales del grupo, misma fuente que el resto de la app)
   - Date picker para la **fecha de jornada** (YYYY-MM-DD). Aclarar en el label: "Fecha de la jornada (día en que empieza la activación)"
   - TextInput para la **hora de inicio** (formato HH:mm)
   - TextInput para la **hora de fin** (formato HH:mm). Si `horaFin < horaInicio`, mostrar una nota inline: "La activación finaliza en la madrugada del día siguiente (misma jornada)."
   - Opción de repetir: checkbox "Repetir esta sesión" que despliega:
     - Picker de días de la semana (multiselect: L M X J V S D)
     - TextInput "Hasta la fecha" (YYYY-MM-DD)
     - Al guardar con repetición: generar automáticamente una sesión por cada día seleccionado entre la fecha inicial y la fecha límite, y enviarlas todas en el body de `POST /api/activaciones/:id/sesiones` como array.
   - Botón "Guardar"
5. Cada sesión en la lista muestra: local, fecha de jornada, franja horaria (`horaInicio` – `horaFin`), estado (badge).
6. Deslizar una sesión a la izquierda (o botón de acciones) → opciones: **Cancelar sesión** (`PATCH estadoSesion: "Cancelada"`) con confirmación, y **Eliminar** (solo sesiones futuras o canceladas).

---

## Tarea 9 — Vista del Planning Diario: `app/(app)/planning-dia/activaciones-dia.tsx`

Pantalla accesible desde el Planning Diario. Muestra las activaciones del día en el local del usuario.

**Comportamiento:**
1. Al cargar: `GET /api/activaciones/sesiones/dia?localId=<localId>&fecha=<hoy>`
2. Si no hay sesiones: mostrar estado vacío con mensaje "No hay activaciones programadas para hoy."
3. Por cada sesión (card), mostrar:
   - **Franja horaria** prominente: `horaInicio – horaFin`. Si `horaFin < horaInicio`, añadir "(hasta madrugada)" para dejar claro que cruza medianoche.
   - **Marca y producto** en negrita
   - **Tipo de activación**
   - **Mecánica**: texto completo (puede ser largo, usar `numberOfLines` expandible con "Ver más")
   - **Equipo**: descripción del equipo
   - **Materiales**: lista de chips
   - Badge de estado: Programada (azul) / Realizada (verde) / Cancelada (gris)
4. Al pie de cada card, mostrar los botones de acción según estado:
   - **Si `estadoSesion === "Programada"`**:
     - Botón **"Cancelar activación"** (rojo/outline) → confirmación modal "¿Seguro que quieres cancelar esta sesión?" → `PATCH estadoSesion: "Cancelada"`. Requiere permiso `activaciones.ver`.
     - Botón **"Marcar como realizada"** (verde) → `PATCH estadoSesion: "Realizada"`. Requiere permiso `activaciones.ver`.
   - **Si `estadoSesion === "Realizada"`**:
     - Botón **"Añadir incidencia"** → abre modal con TextInput multilínea → `PATCH incidencia: "..."`. Si ya tiene incidencia, el botón dice "Editar incidencia" y el modal se abre con el texto existente. Requiere permiso `activaciones.ver`.
   - **Si `estadoSesion === "Cancelada"`**: no mostrar botones de acción, solo el badge.

**Patrón visual:** seguir el mismo estilo de card que `app/(app)/planning-dia/actuaciones.tsx`.

---

## Tarea 10 — Añadir tarjeta en el Planning Diario

En `app/(app)/planning-dia/index.tsx`, añadir al array `TARJETAS` una nueva entrada:

```
{
  id: 'activaciones',
  label: 'Activaciones del día',
  descripcion: 'Campañas de marca programadas para hoy en tu local',
  icon: 'celebration',
  ruta: '/planning-dia/activaciones-dia',
  permiso: 'activaciones.ver',
}
```

Añadir también `activaciones-dia` al Stack de `app/(app)/planning-dia/_layout.tsx` siguiendo el mismo patrón que las otras pantallas.

---

## Tarea 11 — Añadir los permisos al sistema

Buscar en el proyecto dónde se definen o documentan los permisos disponibles (puede ser en `api/`, en un archivo de constantes, en la pantalla `app/(app)/permisos.tsx` o en la documentación). Añadir los dos permisos nuevos:

- **`activaciones.ver`** — Permite ver las activaciones del día en el Planning Diario y marcar sesiones como realizadas o añadir incidencias. Pensado para el personal de barra.
- **`activaciones.gestionar`** — Permite crear, editar y archivar activaciones, y gestionar sus sesiones (programar, cancelar, eliminar). Pensado para administración.

---

## Restricciones importantes

- **No modificar** ninguna pantalla del planning diario existente (cuadrante, actuaciones, arqueo de caja): solo añadir la tarjeta nueva y la nueva pantalla.
- **No romper el routing de reservas**: asegurarse de que la navegación a `/reservas` sigue funcionando después de eliminar `reservas.tsx` y crear la carpeta.
- **El bar solo accede a las activaciones de su propio `localId`**: en `GET /api/activaciones/sesiones/dia`, el backend debe validar que el `localId` del query param coincide con el local autorizado del token del usuario (o que el usuario tenga acceso a ese local).
- **Formato de hora**: usar siempre "HH:mm" en 24h. Al mostrar en el Planning Diario, opcionalmente añadir sufijo AM/PM si la app ya lo hace en otras pantallas.
- **Responsive**: todas las pantallas deben funcionar en web y móvil usando `useBreakpoint` como en el resto del proyecto.
