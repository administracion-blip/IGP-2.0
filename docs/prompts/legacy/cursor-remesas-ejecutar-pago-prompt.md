# Prompt para Cursor: Marcar remesa como pagada con el formulario Registrar pago

## Objetivo

Al pulsar **«Marcar como pagada»** en una remesa (estado `Generada`), en lugar de ejecutar a ciegas, se abre el formulario **Registrar pago** que ya existe en factura-detalle, **una sola vez**, y lo que el usuario rellene (fecha, método de pago, referencia, observaciones) se aplica en bloque a los pagos de TODAS las facturas de la remesa. El importe de cada pago sigue siendo el de su línea de remesa — el formulario no lo pide.

**DECISIÓN INTENCIONAL DE NEGOCIO:** el botón deja de estar disponible en estado `Borrador` (hoy sí lo está). Una remesa solo puede marcarse como pagada tras generar el fichero del banco: primero Excel, luego pago. Retirar `'Borrador'` de la condición del botón en `remesas/[remesaId].tsx`.

## Estado actual (verificado en el código)

- `POST /api/remesas/:remesaId/ejecutar` (en `api/routes/remesas.js`) solo acepta `{ fecha }` y hardcodea: `metodo_pago: 'remesa'`, `referencia: "Remesa <remesaId>"`, `observaciones: concepto de línea`. Tiene validación en dos fases (validar todo → crear pagos) e idempotencia (409 si ya Ejecutada). **Conservar ambas.**
- El formulario Registrar pago es un modal **incrustado** en `app/(app)/facturacion/factura-detalle.tsx`: estados `pagoFecha`, `pagoMetodo`/`pagoMetodoOtro` (con `mapTipoReciboToFormaPago` para el default por proveedor y `resolveMetodoPagoParaEnvio` para el envío), `pagoReferencia`, `pagoObservaciones`, `pagoImporte`. No es reutilizable tal cual.
- Pantalla de detalle de remesa: `app/(app)/facturacion/remesas/[remesaId].tsx`.

## Tarea 1 — Extraer el modal a componente reutilizable

Crear `app/components/RegistrarPagoModal.tsx` (o la carpeta de componentes que use el proyecto) extrayendo el modal de factura-detalle **sin cambio funcional ni visual**:

- Props: `visible`, `onClose`, `onSubmit(payload)`, `modo: 'factura' | 'remesa'`, `variant: 'pago' | 'cobro'` (el título actual es dinámico según `esVenta` — no romper facturas de venta), `initial?: { fecha?, metodo?, referencia?, observaciones? }`, `resumen?: { numFacturas, importeTotal }`, `submitting?: boolean`, `errorExterno?: string`.
- `onSubmit` con payload tipado por unión discriminada según `modo` (con `importe` solo en `'factura'`); nada de `importe?` ambiguo.
- Mover también los **estilos** del modal (`modalOverlay`, `modalContent`, chips…) al componente, no solo el JSX — el criterio es "sin cambio visual".
- La lógica de fecha auto/manual al cambiar método (`onSeleccionarMetodoPago`) vive dentro del modal; los defaults de apertura (`mapTipoReciboToFormaPago`, fecha de factura si tarjeta) los resuelve el padre y entran por `initial`. La lógica compartida ya está en `app/utils/facturacion.ts` — reutilizarla desde ahí.
- `modo 'factura'`: idéntico al actual (incluye campo importe). Refactorizar factura-detalle para usarlo; comportamiento exacto de hoy (defaults por tipo de recibo del proveedor, fecha de factura si método tarjeta, validaciones).
- `modo 'remesa'`: **sin campo importe**. En su lugar, bloque de resumen fijo: «Se registrará el pago de N facturas por un total de X €» (los importes son los de las líneas). Reutilizar el mismo selector de método de pago con lógica de «Otro».
- La lógica compartida (`mapTipoReciboToFormaPago`, `resolveMetodoPagoParaEnvio`, validación de fecha) se mueve con el componente o a un util común — no duplicar.

## Tarea 2 — Ampliar el endpoint de ejecución

`POST /api/remesas/:remesaId/ejecutar` acepta body ampliado:

```
{
  fecha           — YYYY-MM-DD (obligatoria, como hoy)
  metodo_pago?    — string; default si falta: "remesa" (retrocompatible)
  referencia?     — string; default si falta o vacía: "Remesa <remesaId>"
  observaciones?  — string; si viene informada se usa para TODOS los pagos.
                    Vacía, solo espacios o ausente = "no informada" → fallback al
                    concepto de la línea (comportamiento actual). Un pago nunca
                    queda sin observación por borrar el campo en el formulario.
}
```

Nota de coherencia de datos: el formulario nuevo propone `transferencia` por defecto; los clientes antiguos que llamen sin `metodo_pago` siguen registrando `remesa`. Es intencional y retrocompatible — convivirán pagos con ambos métodos.

- Los campos se aplican idénticos a todos los pagos; el `importe` sigue saliendo de cada línea con la validación de pendiente actual.
- Conservar sin tocar: validación en dos fases, idempotencia (409), permisos (`remesas.gestionar` + `facturacion.cobrar_pagar`), respuesta `{ ok, remesa, pagos }`.

## Tarea 3 — Conectar el flujo en el detalle de remesa

En `remesas/[remesaId].tsx`:

- El botón «Marcar como pagada» (visible en estado `Generada`) abre `RegistrarPagoModal` en `modo 'remesa'` con: fecha = hoy, método = `transferencia` (es una remesa bancaria; el usuario puede cambiarlo), referencia = `Remesa <remesaId>` editable, observaciones vacías, y el resumen con nº de facturas e importe total de las líneas.
- El propio modal es el paso de confirmación consciente: incluir bajo el botón de confirmar el aviso «Esta acción crea los pagos en todas las facturas y no se puede deshacer desde aquí». Eliminar el doble diálogo previo si existía (modal + resumen ya cumplen esa función).
- Al confirmar: llamar a `ejecutar` con los campos del formulario, refrescar la remesa y mostrar el resultado (nº de pagos creados).
- Si el endpoint devuelve error por alguna factura (validación fase 1), mostrar el mensaje del backend sin cerrar el modal.

## Reglas no opcionales

1. El formulario NO permite editar importes: eso se hace en las líneas de la remesa antes de ejecutar.
2. Un solo submit = una sola llamada a `ejecutar`. Deshabilitar el botón mientras responde (evitar doble tap → el 409 es la red de seguridad, no el flujo normal).
3. El refactor de factura-detalle no cambia nada observable para el usuario.

## Criterios de aceptación

- Registrar un pago desde factura-detalle funciona exactamente igual que antes del refactor.
- Ejecutar una remesa de 3 facturas rellenando método «Transferencia», referencia «REM-2026-08» y una observación crea 3 pagos con esos tres valores idénticos y los importes de sus líneas.
- Ejecutar sin tocar referencia crea pagos con `Remesa <remesaId>`.
- Doble tap en confirmar no duplica pagos.
- Llamar a `ejecutar` solo con `{ fecha }` (cliente antiguo) sigue funcionando como hoy.
- Observaciones vacías o con solo espacios → cada pago conserva el concepto de su línea.
- Error de validación en fase 1 (p. ej. pendiente insuficiente) → el modal permanece abierto con el mensaje del backend visible y la remesa no cambia de estado.
- El botón «Marcar como pagada» NO aparece en estado `Borrador`.
