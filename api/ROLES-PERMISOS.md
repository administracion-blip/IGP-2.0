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

## Códigos de permiso

### Módulos (menú lateral)

| Código | Descripción |
|--------|-------------|
| `base_datos.ver` | Ver menú Base de Datos |
| `mantenimiento.ver` | Ver menú Mantenimiento |
| `compras.ver` | Ver menú Compras |
| `cajas.ver` | Ver menú Cajas |
| `cashflow.ver` | Ver menú Cashflow |
| `actuaciones.ver` | Ver menú Actuaciones |
| `rrpp.ver` | Ver menú Rrpp |
| `mystery_guest.ver` | Ver menú Mystery Guest |
| `reservas.ver` | Ver menú Reservas |

### Acciones granulares por pantalla

| Código | Descripción |
|--------|-------------|
| `usuarios.ver` | Usuarios · Ver |
| `usuarios.crear` | Usuarios · Crear |
| `usuarios.editar` | Usuarios · Editar |
| `usuarios.borrar` | Usuarios · Borrar |
| `locales.ver` | Locales · Ver |
| `locales.crear` | Locales · Crear |
| `locales.editar` | Locales · Editar |
| `locales.borrar` | Locales · Borrar |
| `empresas.ver` | Empresas · Ver |
| `empresas.crear` | Empresas · Crear |
| `empresas.editar` | Empresas · Editar |
| `empresas.importar` | Empresas · Importar |
| `productos.ver` | Productos · Ver |
| `productos.editar` | Productos · Editar |
| `productos.sincronizar` | Productos · Sincronizar |
| `almacenes.ver` | Almacenes · Ver |
| `almacenes.crear` | Almacenes · Crear |
| `almacenes.editar` | Almacenes · Editar |
| `almacenes.borrar` | Almacenes · Borrar |
| `almacenes.sincronizar` | Almacenes · Sincronizar |
| `puntos_venta.ver` | Puntos de venta · Ver |
| `puntos_venta.editar` | Puntos de venta · Editar |
| `permisos.ver` | Permisos · Ver |
| `permisos.crear` | Permisos · Crear |
| `permisos.editar` | Permisos · Editar |
| `permisos.borrar` | Permisos · Borrar |
| `cierres.ver` | Cierres teóricos · Ver |
| `cierres.crear` | Cierres teóricos · Crear |
| `cierres.editar` | Cierres teóricos · Editar |
| `cierres.borrar` | Cierres teóricos · Borrar |
| `cierres.sincronizar` | Cierres teóricos · Sincronizar |
| `cierres.exportar` | Cierres teóricos · Exportar |
| `comparativa.ver` | Comparativa fechas · Ver |
| `comparativa.crear` | Comparativa fechas · Crear |
| `comparativa.editar` | Comparativa fechas · Editar |
| `comparativa.borrar` | Comparativa fechas · Borrar |
| `comparativa.importar` | Comparativa fechas · Importar |
| `comparativa.exportar` | Comparativa fechas · Exportar |
| `objetivos.ver` | Objetivos · Ver |
| `objetivos.compartir` | Objetivos · Compartir |
| `mantenimiento.crear` | Mantenimiento · Crear incidencias |
| `mantenimiento.editar` | Mantenimiento · Editar / marcar reparado |
| `mantenimiento.borrar` | Mantenimiento · Borrar incidencias |
| `pedidos.ver` | Pedidos · Ver |
| `pedidos.crear` | Pedidos · Crear |
| `pedidos.editar` | Pedidos · Editar |
| `pedidos.borrar` | Pedidos · Borrar |
| `compras_proveedor.ver` | Compras proveedor · Ver |
| `compras_proveedor.sincronizar` | Compras proveedor · Sincronizar |
| `acuerdos.ver` | Acuerdos · Ver |
| `acuerdos.crear` | Acuerdos · Crear |
| `acuerdos.editar` | Acuerdos · Editar |
| `acuerdos.borrar` | Acuerdos · Borrar |
| `acuerdos.exportar` | Acuerdos · Exportar PDF |

## Comportamiento

- Si el usuario no tiene rol o la tabla no devuelve permisos para ese rol, se considera "sin restricción" y se muestran todas las entradas de menú (compatibilidad con instalaciones sin tabla de permisos).
- Si el rol tiene al menos un permiso en la tabla, solo se muestran las entradas cuyo código esté en la lista.
- Los permisos de menú (`*.ver` de los módulos principales) controlan la visibilidad del menú lateral.
- Los permisos granulares controlan botones/acciones dentro de cada pantalla.

## Ejemplo de ítems (DynamoDB)

Para el rol `Administrador` con acceso completo a cajas:

| PK                 | SK                          |
|--------------------|-----------------------------|
| ROL#Administrador  | PERMISO#cajas.ver           |
| ROL#Administrador  | PERMISO#cierres.ver         |
| ROL#Administrador  | PERMISO#cierres.crear       |
| ROL#Administrador  | PERMISO#cierres.editar      |
| ROL#Administrador  | PERMISO#cierres.borrar      |
| ROL#Administrador  | PERMISO#cierres.sincronizar |
| ROL#Administrador  | PERMISO#cierres.exportar    |

Para el rol `Socio` solo ver:

| PK            | SK                    |
|---------------|-----------------------|
| ROL#Socio     | PERMISO#cajas.ver     |
| ROL#Socio     | PERMISO#cierres.ver   |
| ROL#Socio     | PERMISO#objetivos.ver |
