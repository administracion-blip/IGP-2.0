# Módulo de Mantenimiento – Incidencias

La tabla DynamoDB `Igp_Mantenimiento` almacena incidencias, trabajos, valoraciones y log. Integra con `igp_Locales`, `igp_usuarios` y `igp_Empresas`.

## Variables de entorno (api/.env o api/.env.local)

- `DDB_MANTENIMIENTO_TABLE` – Tabla DynamoDB (por defecto `Igp_Mantenimiento`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `Igp_Mantenimiento` (o el valor de `DDB_MANTENIMIENTO_TABLE`)
- **Clave de partición:** `PK` (String)
- **Clave de ordenación:** `SK` (String)

## Incidencias – Patrones de clave

| Entidad | PK | SK |
|---------|-----|-----|
| Incidencia | `LOCAL#{id_Locales}` | `INC#{timestamp}#{uuid}` |

`local_id` referencia `igp_Locales.id_Locales`. `creado_por_id_usuario` referencia `igp_usuarios.id_usuario`.

## Endpoints (Fase 1)

**POST** `/api/mantenimiento/incidencias`

- **Body:** `{ local_id, zona, categoria, titulo, descripcion, prioridad_reportada, creado_por_id_usuario? }`
- `creado_por_id_usuario` opcional (puede venir en body o header `X-User-Id`)
- Respuesta: `{ ok: true, incidencia: { ... } }`

**GET** `/api/mantenimiento/incidencias`

- **Query params:** `local_id`, `creado_por`, `estado` (opcionales)
- Respuesta: `{ incidencias: [ ... ] }`

## Enums

- **zona:** barra, cocina, baños, almacén, sala, terraza, otros
- **categoria:** electricidad, fontanería, frío, mobiliario, limpieza técnica, IT, plagas, otros
- **prioridad_reportada:** baja, media, alta, urgente
- **estado:** Nuevo (al crear), Programado (al asignar fecha de programación), Reparacion (al marcar reparado). Opcional: CANCELADA.
