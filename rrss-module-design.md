# Módulo RRSS — Diseño y arquitectura
_Documento de referencia para implementación_

---

## Objetivo

Dar a los equipos de marketing y a los usuarios locales una herramienta integrada en el ERP para gestionar las publicaciones en redes sociales: propuestas, aprobación, calendario, generación de prompts de IA para imágenes y carteles de músicos.

---

## Roles y permisos

| Rol | Qué puede hacer |
|---|---|
| **Usuario local** | Crear propuestas simples (tipo, fecha, descripción breve) |
| **Marketing / Admin** | Crear propuestas, revisar y aprobar/rechazar las de locales, editar prompt estilo, gestionar calendario, generar prompts IA |

---

## Dinámica del flujo principal

### Propuesta de usuario local

El usuario del local accede al módulo RRSS y abre "Nueva propuesta". Rellena un formulario mínimo:

- **Tipo de publicación**: desplegable con opciones predefinidas (Oferta, Evento, Novedad, Menú del día, Agradecimiento, Otro).
- **Red(es) destino**: Instagram, Facebook, TikTok (multiselect).
- **Fecha sugerida**: datepicker.
- **Descripción breve**: un campo de texto libre de pocas líneas donde explica la idea ("queremos promocionar el menú de San Valentín con un 2x1 en postres").
- Opcionalmente puede adjuntar una foto de referencia.

La propuesta queda en estado `pendiente` y Marketing recibe una notificación.

### Flujo Marketing

Marketing ve en su vista todas las propuestas pendientes y las del calendario ya programado. Para cada propuesta puede:

1. **Aprobar** → pasa a `aprobada` y entra en el calendario con la fecha sugerida (ajustable).
2. **Rechazar** → con comentario opcional visible para el local.
3. **Editar** → puede modificar cualquier campo antes de aprobar.
4. **Crear directamente** → Marketing también puede crear propuestas sin que vengan de un local.

Una vez aprobada, Marketing puede generar el prompt de IA para el diseño de la imagen.

### Generación del prompt IA

Al pulsar "Generar prompt", el sistema compone automáticamente un texto optimizado para Midjourney / DALL·E 3 / Firefly combinando:

- `estilo_visual_brief` del local (brief de identidad visual, editado por Marketing en config del local).
- Tipo de publicación y descripción de la propuesta.
- Red destino (formato cuadrado para Instagram, vertical para Stories/TikTok, etc.).
- Instrucciones base según el tipo (producto, ambiente, personas, etc.).

El prompt generado es editable antes de copiarlo a la herramienta de IA. Marketing sube la imagen resultante a la propuesta.

### Publicación y métricas (opcional)

Marketing puede marcar la propuesta como `publicada` con la URL del post. Opcionalmente se registran métricas básicas (alcance, interacciones) para consulta posterior.

---

## Flujo especial — Carteles de músicos

Este flujo es iniciado exclusivamente por Marketing. No requiere propuesta previa.

1. Marketing selecciona **local** y **rango de fechas**.
2. El sistema consulta `Igp_Actuaciones` + `Igp_Artistas` y devuelve la lista de actuaciones del período.
3. Para cada actuación se genera automáticamente un prompt personalizado combinando:
   - Datos del artista: nombre, género musical, foto de referencia (si existe en `Igp_Artistas`).
   - Datos de la actuación: fecha, hora, nombre del evento.
   - `estilo_visual_brief` del local.
   - Plantilla base para cartel de música (formato vertical A3/Story, tipografía destacada para nombre del artista, fecha prominente).
4. Marketing puede editar cada prompt individualmente antes de generarlo.
5. Sube el cartel resultante, que queda asociado a la actuación y al local para el historial.

---

## Campo `estilo_visual_brief` en `Igp_Locales`

Atributo string en la tabla DynamoDB existente. Sin migración necesaria (se escribe la primera vez que Marketing lo rellena).

**Nombre del atributo:** `estilo_visual_brief`

**Contenido:** brief de identidad visual en lenguaje de prompt, redactado por Marketing. Ejemplo:

> "Restaurante familiar mediterráneo. Ambiente cálido y acogedor. Paleta tierra: naranja, ocre, verde oliva. Tipografía clásica serif. Fotografía natural con luz cálida. Sin elementos corporativos fríos."

**Reglas:**
- Solo editable por Marketing/Admin, no por el usuario local.
- Si está vacío, el generador usa un fallback genérico basado en el `tipo_negocio` del local.
- Se edita desde la pantalla de configuración del local dentro del módulo RRSS.

---

## Diseño de datos — DynamoDB

### Tabla `Igp_RRSS_Propuestas`

| Atributo | Tipo | Notas |
|---|---|---|
| `id_propuesta` | String (PK) | UUID |
| `id_local` | String | FK a Igp_Locales |
| `id_empresa` | String | Para filtros multi-empresa |
| `tipo` | String | Oferta / Evento / Novedad / etc. |
| `redes` | StringSet | instagram, facebook, tiktok |
| `fecha_sugerida` | String | ISO date |
| `descripcion` | String | Texto libre del solicitante |
| `imagen_referencia_url` | String | S3 presigned o key |
| `estado` | String | pendiente / aprobada / rechazada / publicada |
| `creado_por` | String | id_usuario |
| `creado_en` | String | ISO datetime |
| `aprobado_por` | String | id_usuario Marketing |
| `aprobado_en` | String | ISO datetime |
| `comentario_rechazo` | String | Opcional |
| `prompt_generado` | String | Texto del prompt IA |
| `imagen_final_url` | String | URL del diseño subido |
| `url_publicacion` | String | URL del post en RRSS |
| `metricas` | Map | { alcance, interacciones } — opcional |

**GSIs previstos:**
- `Local-Estado-index`: PK `id_local`, SK `estado` → para la vista del local y el filtro de pendientes de Marketing.
- `Local-Fecha-index`: PK `id_local`, SK `fecha_sugerida` → para el calendario.

### Carteles de músicos

No requieren tabla propia. Se crean como propuestas con `tipo = 'Cartel Músico'` y un atributo adicional `id_actuacion` que las vincula a `Igp_Actuaciones`.

---

## Rutas API previstas

```
GET    /api/rrss/propuestas              → lista con filtros (local, estado, fechas)
POST   /api/rrss/propuestas              → crear propuesta
GET    /api/rrss/propuestas/:id          → detalle
PATCH  /api/rrss/propuestas/:id          → actualizar estado / campos
DELETE /api/rrss/propuestas/:id          → borrar (solo pendientes propias)

POST   /api/rrss/propuestas/:id/prompt   → generar prompt IA
POST   /api/rrss/carteles-musico/generar → recibe {id_local, fecha_inicio, fecha_fin},
                                           devuelve lista de prompts por actuación

GET    /api/rrss/locales/:id/estilo      → leer estilo_visual_brief
PATCH  /api/rrss/locales/:id/estilo      → actualizar estilo_visual_brief
```

---

## Pantallas frontend previstas

| Pantalla | Rol | Descripción |
|---|---|---|
| `rrss/index.tsx` | Ambos | Entrada: vista local (mis propuestas) vs. vista Marketing (todas + calendario) |
| `rrss/nueva-propuesta.tsx` | Local | Formulario simplificado |
| `rrss/propuesta/[id].tsx` | Ambos | Detalle, acciones según rol |
| `rrss/calendario.tsx` | Marketing | Vista mensual de propuestas aprobadas |
| `rrss/carteles-musico.tsx` | Marketing | Selector local+fechas, lista de actuaciones, prompts |
| `rrss/config-local.tsx` | Marketing | Edición de `estilo_visual_brief` por local |

---

## Estado del módulo

| Elemento | Estado |
|---|---|
| Diseño de flujo y roles | ✅ definido |
| Modelo de datos DynamoDB | ✅ definido |
| Campo `estilo_visual_brief` | ✅ definido |
| Rutas API | ✅ estructura definida |
| Pantallas frontend | ✅ listadas |
| Implementación | ⏳ pendiente |
