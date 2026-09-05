# Prompt para Cursor: Módulo de Regularización de Inventario

## Contexto del proyecto

- Framework: React Native / Expo con backend Node.js/Express en `/api`
- Base de datos: DynamoDB. Las tablas se referencian por nombre de variable de entorno (`process.env.DYNAMODB_TABLE_*`)
- Fuente de stock: Ágora Software, vía API HTTP (`/api/export-master/`)
- Cliente Ágora ya implementado en `api/lib/agora/client.js`
- El módulo de compras ya existe en `app/(app)/compras/` con su `_layout.tsx`
- Patrón de permisos: `hasPermiso('compras.regularizacion')` siguiendo el patrón de otros módulos en `useAuth()`

El módulo de regularización de inventario permite comparar semanalmente el **stock teórico** que Ágora calcula (basado en entradas y ventas) con el **stock real** contado físicamente por el equipo. El informe se organiza por **grupos de familias de productos** configurables.

---

## Tarea 1 — Añadir `exportStocks` al cliente Ágora (`api/lib/agora/client.js`)

Añadir una nueva función exportada siguiendo exactamente el mismo patrón que `exportFamilies` y `exportWarehouses`:

```
exportStocks(warehouseId?, categoryId?)
```

- Llama a `/api/export-master/?filter=Stocks`
- Si recibe `warehouseId` (número), añade el parámetro `where-stock-warehouse-id=<warehouseId>`
- Si recibe `categoryId` (número), añade `where-product-category-id=<categoryId>`
- La respuesta de Ágora tiene la forma `{ Stocks: [{ WarehouseId, ProductId, Quantity, SizeId, ColorId }] }`
- Devolver el array `data.Stocks || data.stocks || []`
- Incluir `MAX_RETRIES` y `fetchWithTimeout` igual que el resto de funciones del archivo

---

## Tarea 2 — Crear tabla DynamoDB para grupos de familias

En `api/lib/db.js` (o donde se definan los nombres de tablas del proyecto), registrar dos nuevas tablas de entorno:

- `DYNAMODB_TABLE_REGULARIZACION_GRUPOS` — persiste las configuraciones de grupos de familias
- `DYNAMODB_TABLE_REGULARIZACIONES` — persiste el histórico de regularizaciones completadas

Si el proyecto usa un objeto centralizado de tablas, añadirlas allí siguiendo el patrón existente.

---

## Tarea 3 — Crear `api/routes/regularizacion.js`

Crear el archivo con los siguientes endpoints. Seguir el patrón de autenticación y manejo de errores de `api/routes/agora.js` o `api/routes/almacenes.js`.

### `GET /api/regularizacion/grupos`
Devuelve todos los grupos de familias guardados en `DYNAMODB_TABLE_REGULARIZACION_GRUPOS`.
- Cada ítem tiene: `{ grupoId (PK), nombre, familyIds: number[], updatedAt }`
- Hacer un `scan` o usar un GSI si existe por local (`localId`). Incluir siempre el `localId` del usuario autenticado como filtro.

### `POST /api/regularizacion/grupos`
Crea o actualiza un grupo de familias.
- Body: `{ grupoId?, nombre, familyIds: number[] }`
- Si `grupoId` no viene, generar un UUID con `crypto.randomUUID()`
- Requiere permiso `compras.regularizacion`

### `DELETE /api/regularizacion/grupos/:grupoId`
Elimina un grupo de familias.
- Requiere permiso `compras.regularizacion`

### `GET /api/regularizacion/stock-teorico`
Parámetros query: `warehouseId` (obligatorio), `familyIds` (array de números separados por coma).

Lógica:
1. Llamar a `exportStocks(warehouseId)` de `api/lib/agora/client.js`
2. Llamar a la función de productos de Ágora para obtener la lista de productos con `FamilyId` y `FamilyName` (ya existe en `api/routes/agora.js` — reutilizar o importar la función correspondiente)
3. Cruzar stocks con productos: para cada stock, añadir `ProductName`, `FamilyId`, `FamilyName`
4. Si llegan `familyIds`, filtrar solo los productos cuyo `FamilyId` esté en la lista
5. Devolver array: `[{ ProductId, ProductName, FamilyId, FamilyName, WarehouseId, stockTeorico: Quantity }]`

### `POST /api/regularizacion`
Guarda una regularización completada.

Body esperado:
```json
{
  "warehouseId": 1,
  "warehouseName": "Almacén Central",
  "grupoId": "uuid-del-grupo",
  "grupoNombre": "Bebidas",
  "fecha": "2026-06-30",
  "lineas": [
    {
      "ProductId": 101,
      "ProductName": "Cerveza 1/3",
      "FamilyId": 5,
      "FamilyName": "Cervezas",
      "stockTeorico": 48,
      "stockReal": 44,
      "diferencia": -4
    }
  ]
}
```

- Generar `regularizacionId` con `crypto.randomUUID()`
- Añadir `creadoEn: new Date().toISOString()` y el `localId` del usuario autenticado
- Persistir en `DYNAMODB_TABLE_REGULARIZACIONES`
- Requiere permiso `compras.regularizacion`

### `GET /api/regularizacion`
Devuelve el histórico de regularizaciones del local autenticado, ordenadas por `creadoEn` descendente.
- Añadir query params opcionales: `limit` (default 20), `warehouseId`

---

## Tarea 4 — Registrar la ruta en `api/index.js` (o el archivo principal de rutas)

Importar `regularizacion.js` y montar en `/api/regularizacion` siguiendo el patrón de las demás rutas del proyecto.

---

## Tarea 5 — Pantalla de configuración de grupos: `app/(app)/compras/regularizacion-grupos.tsx`

Pantalla que permite al usuario crear y gestionar los grupos de familias que se usarán en los informes.

**Comportamiento:**
1. Al cargar: `GET /api/regularizacion/grupos` para listar los grupos existentes y `GET /api/agora/familias` (o el endpoint equivalente que ya devuelve las familias de Ágora) para mostrar todas las familias disponibles.
2. Lista de grupos existentes con nombre y número de familias asignadas.
3. Botón "Nuevo grupo" → abre un modal con:
   - Campo de texto para el nombre del grupo
   - Lista de familias de Ágora con checkbox para seleccionar cuáles pertenecen al grupo
   - Botón "Guardar" → `POST /api/regularizacion/grupos`
4. Al tocar un grupo existente, abrir el mismo modal en modo edición (`POST` sobreescribe por `grupoId`).
5. Botón de eliminar en cada grupo → `DELETE /api/regularizacion/grupos/:grupoId` con confirmación.

**Patrón visual:** seguir el mismo estilo de `app/(app)/compras/almacen.tsx` (chips de filtro, lista de tarjetas, modal).

---

## Tarea 6 — Pantalla principal de regularización: `app/(app)/compras/regularizacion.tsx`

Pantalla de dos pasos.

### Paso 1 — Configuración

Controles en la parte superior:
- **Selector de almacén**: dropdown/picker con los almacenes obtenidos de `GET /api/agora/almacenes` o `exportWarehouses()`. Al seleccionar, guarda el valor en el estado.
- **Selector de grupo de familias**: lista de grupos guardados (`GET /api/regularizacion/grupos`). Al seleccionar un grupo, muestra el número de familias incluidas.
- **Selector de fecha**: date picker con valor por defecto = hoy.
- Botón **"Cargar stock teórico"** → llama a `GET /api/regularizacion/stock-teorico?warehouseId=X&familyIds=Y,Z,...`

### Paso 2 — Captura de conteo real e informe

Se muestra cuando los datos de stock teórico han cargado.

**Tabla de productos** con las columnas:
| Familia | Producto | Stock teórico | Stock real | Diferencia |
|---------|----------|--------------|------------|------------|

- La columna **Stock real** es un `TextInput` numérico editable por el usuario.
- La columna **Diferencia** se calcula en tiempo real: `stockReal - stockTeorico`. Mostrar en verde si es 0, en rojo si es negativo, en naranja si es positivo.
- Agrupar visualmente por `FamilyName` con un encabezado de sección.

**Resumen al pie:**
- Total de productos revisados
- Total de diferencias (suma de valores absolutos)
- Nº de productos con diferencia negativa / positiva / sin diferencia

**Botón "Guardar regularización":**
- Valida que todos los campos de stock real estén rellenos (no vacíos).
- Llama a `POST /api/regularizacion` con todos los datos.
- Al éxito: mostrar mensaje de confirmación y ofrecer botón "Nueva regularización" para reiniciar el formulario.

**Botón "Ver histórico":**
- Navega a `app/(app)/compras/regularizacion-historico.tsx` (Tarea 7).

**Patrón visual:** seguir el mismo estilo de `app/(app)/compras/compras-proveedor.tsx` para la tabla de líneas y `app/(app)/compras/detalles-pedidos.tsx` para los encabezados de sección por agrupación.

---

## Tarea 7 — Pantalla de histórico: `app/(app)/compras/regularizacion-historico.tsx`

Lista las regularizaciones pasadas obtenidas de `GET /api/regularizacion`.

Cada ítem de la lista muestra:
- Fecha
- Nombre del almacén
- Nombre del grupo de familias
- Nº de productos revisados
- Total de diferencias (suma absoluta)
- Indicador visual: verde (sin diferencias), amarillo (diferencias leves), rojo (diferencias significativas >5%)

Al tocar un ítem: mostrar el detalle completo de esa regularización (las lineas completas) en un modal o pantalla de detalle.

---

## Tarea 8 — Actualizar `app/(app)/compras/_layout.tsx`

Añadir las tres nuevas pantallas al Stack:

```
regularizacion
regularizacion-grupos
regularizacion-historico
```

Seguir el mismo patrón que las demás entradas del Stack existentes.

---

## Tarea 9 — Añadir entrada en el menú/índice de Compras

En `app/(app)/compras/index.tsx`, añadir una tarjeta o botón de navegación para "Regularización de Inventario" que lleve a `regularizacion`.

Usar el mismo componente de tarjeta de navegación que ya usan los demás accesos del módulo de compras (pedidos, almacén, compras proveedor, etc.).

El botón solo debe mostrarse si `hasPermiso('compras.regularizacion')`.

---

## Restricciones importantes

- **No modificar** el flujo de pedidos ni el resto del módulo de compras.
- **No duplicar** la lógica de productos/familias de Ágora: reutilizar las funciones ya existentes en `api/lib/agora/client.js` y `api/routes/agora.js`.
- **Seguir el patrón de autenticación existente**: todas las rutas del backend deben verificar el token y el `localId` del usuario, igual que el resto de rutas.
- **No hardcodear IDs** de almacenes ni familias: todo debe venir de Ágora en tiempo real.
- **Gestionar errores de red**: si la llamada a Ágora para el stock teórico falla, mostrar un mensaje claro al usuario y permitir reintentar.
- **Formato de números**: usar `formatMoneda` (o la función equivalente de `utils/`) para mostrar cantidades con decimales correctamente.
- **Responsive**: las pantallas deben funcionar en web (tablet/escritorio) y móvil, siguiendo el hook `useBreakpoint` ya presente en el proyecto.
