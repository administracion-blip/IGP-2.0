# Roles y permisos

La tabla DynamoDB `Igp_RolesPermisos` (o el valor de `DDB_ROLES_PERMISOS_TABLE`) almacena la relación rol → permisos. Cada ítem es un par (rol, permiso).

## Variables de entorno (api/.env o api/.env.local)

- `DDB_ROLES_PERMISOS_TABLE` – Tabla DynamoDB (por defecto `Igp_RolesPermisos`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `Igp_RolesPermisos` (o el valor de `DDB_ROLES_PERMISOS_TABLE`)
- **Clave de partición (PK):** String
- **Clave de ordenación (SK):** String

## Patrones de clave

| PK            | SK              | Descripción        |
|---------------|------------------|--------------------|
| `ROL#<nombreRol>` | `PERMISO#<codigo>` | Un permiso asignado al rol |

El `<nombreRol>` debe coincidir exactamente con el campo `Rol` de la tabla de usuarios (ej. `Administrador`, `SuperUser`, `Local`).

## Endpoint

**GET** `/api/permisos?rol=<nombreRol>`

- Devuelve `{ permisos: ['base_datos.ver', 'mantenimiento.ver', ...] }`
- Los códigos se obtienen quitando el prefijo `PERMISO#` del atributo SK de cada ítem.

## Códigos de permiso usados en la app (menú)

- `base_datos.ver` – Ver menú Base de Datos
- `mantenimiento.ver` – Ver menú Mantenimiento
- `compras.ver` – Ver menú Compras
- `cajas.ver` – Ver menú Cajas
- `cashflow.ver` – Ver menú Cashflow
- `actuaciones.ver` – Ver menú Actuaciones
- `rrpp.ver` – Ver menú Rrpp
- `mystery_guest.ver` – Ver menú Mystery Guest
- `reservas.ver` – Ver menú Reservas

Inicio no requiere permiso (siempre visible).

## Comportamiento

- Si el usuario no tiene rol o la tabla no devuelve permisos para ese rol, se considera “sin restricción” y se muestran todas las entradas de menú (compatibilidad con instalaciones sin tabla de permisos).
- Si el rol tiene al menos un permiso en la tabla, solo se muestran las entradas cuyo código esté en la lista.

## Ejemplo de ítems (DynamoDB)

Para el rol `Administrador` con acceso a todo:

| PK                 | SK                    |
|--------------------|------------------------|
| ROL#Administrador  | PERMISO#base_datos.ver |
| ROL#Administrador  | PERMISO#mantenimiento.ver |
| ROL#Administrador  | PERMISO#compras.ver   |
| ROL#Administrador  | PERMISO#cajas.ver     |
| ROL#Administrador  | PERMISO#cashflow.ver  |
| ROL#Administrador  | PERMISO#actuaciones.ver |
| ROL#Administrador  | PERMISO#rrpp.ver      |
| ROL#Administrador  | PERMISO#mystery_guest.ver |
| ROL#Administrador  | PERMISO#reservas.ver  |

Para el rol `Local` solo mantenimiento:

| PK            | SK                      |
|---------------|-------------------------|
| ROL#Local     | PERMISO#mantenimiento.ver |
