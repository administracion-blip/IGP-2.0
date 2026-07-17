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
| `ROL#<nombreRol>` | `META` | Catálogo del rol (nombre, descripción, orden, sistema) |
| `ROL#<nombreRol>` | `PERMISO#<codigo>` | Un permiso asignado al rol |

El `<nombreRol>` debe coincidir exactamente con el campo `Rol` de la tabla de usuarios (ej. `Administrador`, `SuperUser`, `Local`).

## Catálogo de roles (API)

**GET** `/api/roles` — Lista roles registrados (requiere sesión). Devuelve `{ roles: [{ nombre, descripcion, sistema, orden, permisosCount }] }`.

**POST** `/api/roles` — Crea rol (solo Administrador). Body: `{ nombre, descripcion?, clonarDe? }`. Si `clonarDe` indica otro rol, copia sus permisos.

**PUT** `/api/roles/:nombre` — Actualiza descripción u orden (solo Administrador).

**DELETE** `/api/roles/:nombre` — Elimina rol y sus permisos si ningún usuario lo tiene asignado. No se puede borrar `Administrador`.

Migración inicial de roles existentes:

```bash
node api/scripts/seed-roles-catalog.js
```

Inserta ítems `META` para: Administrador, SuperUser, Administracion, Local, Socio, Marketing.

## Endpoints de permisos

**GET** `/api/permisos?rol=<nombreRol>`

- Devuelve `{ permisos: ['base_datos.ver', 'mantenimiento.ver', ...] }`
- Los códigos se obtienen quitando el prefijo `PERMISO#` del atributo SK de cada ítem.

## Códigos de permiso

### Módulos (menú lateral)

La lista canónica de permisos de menú lateral está en `app/constants/modulos.ts` (`PERMISOS_MENU_LATERAL`).
La pantalla **Permisos** agrupa cada módulo con su permiso **Ver módulo (menú)** y las acciones granulares debajo (misma fila = un código; desmarcado = bloqueado para ese rol).

### Módulos (menú lateral)

La lista canónica de permisos «Ver módulo» está en `app/constants/modulos.ts` (`PERMISOS_MENU_LATERAL`).
En la matriz aparecen dentro de su familia (Acuerdos, Facturación, Compras, etc.), no en un grupo suelto.

| Código | Descripción |
|--------|-------------|
| `base_datos.ver` | Ver menú Base de Datos |
| `mantenimiento.ver` | Ver menú Mantenimiento |
| `compras.ver` | Ver menú Compras |
| `cajas.ver` | Ver menú Cajas |
| `cashflow.ver` | Ver menú Cashflow |
| `actuaciones.ver` | Ver menú Actuaciones y consulta del día |
| `rrpp.ver` | Ver menú Rrpp |
| `recursos_humanos.ver` | Ver menú Recursos Humanos (hub de empleados y cuadrante) |
| `marketing.proponer` | Ver menú Marketing (propuestas y RRSS) |
| `mystery_guest.ver` | Ver menú Mystery Guest |
| `reservas.ver` | Ver menú Reservas |
| `acuerdos.ver` | Ver menú Acuerdos |
| `facturacion.ver` | Ver menú Facturación |
| `planning_dia.ver` | Ver menú Planning del Día |
| `ia.informes` | Ver menú Informes IA (y operar con la IA) |

### Configuración (engranaje de cabecera)

| Código | Descripción |
|--------|-------------|
| `permisos.ver` | Ver pantalla Permisos |
| `ajustes.ver` | Ver pantalla Ajustes |

### Legacy

| Código | Descripción |
|--------|-------------|
| `rrss.ver` | **Obsoleto** — equivalente legacy de `marketing.proponer` (sigue funcionando vía alias) |

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
| `usuarios_agora.ver` | Usuarios Ágora (maestro) · Ver |
| `usuarios_agora.sincronizar` | Usuarios Ágora (maestro) · Sincronizar |
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
| `cashflow.registrar` | Cashflow · Registrar y firmar movimientos |
| `cashflow.validar` | Cashflow · Validar importes altos, reparto socios y anular |
| `ia.informe_objetivos` | Informes IA · Fuente Objetivos (expone importes por local) |
| `ia.informe_compras` | Informes IA · Fuente Compras (variaciones de gasto por proveedor/familia/producto) |
| `ia.informe_ventas_hora` | Informes IA · Fuente Ventas por hora (distribución horaria y por franjas) |
| `ia.prompts_gestionar` | Informes IA · Crear/editar/borrar plantillas de prompt |
| `ia.ajustes` | Informes IA · Modificar ajustes de la IA (modelo, temperatura, límites) |
| `formas_pago.editar` | Formas de pago · Editar maestro (Base de datos) |
| `comparativa.ver` | Comparativa fechas · Ver |
| `comparativa.crear` | Comparativa fechas · Crear |
| `comparativa.editar` | Comparativa fechas · Editar |
| `comparativa.borrar` | Comparativa fechas · Borrar |
| `comparativa.importar` | Comparativa fechas · Importar |
| `comparativa.exportar` | Comparativa fechas · Exportar |
| `objetivos.ver` | Objetivos · Ver |
| `objetivos.compartir` | Objetivos · Compartir |
| `excepciones.ver` | Control de excepciones · Ver |
| `excepciones.exportar` | Control de excepciones · Exportar |
| `top.ver` | Top · Ver |
| `top.exportar` | Top · Exportar |
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
| `marketing.proponer` | Marketing · Crear y editar propuestas propias |
| `marketing.gestionar` | Marketing · Visión global, aprobar/rechazar, prompts IA, carteles, estilos |
| `personal.ver` | Personal · Ver empleados (Factorial HR) |
| `activaciones.ver` | Activaciones de marca · Ver las del día en Planning Diario y lista en solo lectura; marcar realizada/cancelada y añadir incidencias (personal de barra) |
| `activaciones.gestionar` | Activaciones de marca · Crear, editar y archivar campañas; programar, cancelar y eliminar sesiones (administración) |
| `incentivos_producto.ver` | Incentivos por producto · Ver campañas y resultados |
| `incentivos_producto.gestionar` | Incentivos por producto · Crear, editar, activar y archivar campañas |
| `incentivos_producto.exportar` | Incentivos por producto · Exportar informe Excel/PDF |
| `remesas.ver` | Remesas de pago · Ver |
| `remesas.gestionar` | Remesas de pago · Crear, generar fichero BBVA, ejecutar y anular |
| `planning_dia.ver` | Planning del Día · Ver menú y acciones del hub |
| `planning_dia.objetivo_card` | Planning del Día · Card de consecución del objetivo mensual (solo %) |
| `planning_dia.actuaciones` | Planning del Día · Tarjeta y pantalla actuaciones del día |
| `planning_dia.activaciones` | Planning del Día · Tarjeta y pantalla activaciones del día |
| `planning_dia.arqueo` | Planning del Día · Tarjeta arqueo de caja (alternativa a `cierres.ver`) |
| `actuaciones.programacion` | Actuaciones · Programación y fichas de artistas |
| `actuaciones.crear` | Actuaciones · Crear actuaciones / huecos |
| `actuaciones.editar` | Actuaciones · Editar actuaciones |
| `actuaciones.borrar` | Actuaciones · Borrar actuaciones |
| `actuaciones.firma` | Actuaciones · Firmar actuación |
| `actuaciones.facturacion` | Actuaciones · Asociar facturas de gasto |

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
