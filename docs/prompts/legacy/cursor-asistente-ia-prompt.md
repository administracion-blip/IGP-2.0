# Prompt para Cursor: Asistentes IA — Informe de compras y variaciones de facturación por hora

> Implementar por fases EN ORDEN. La Fase 1 es autónoma y se entrega sola.

## Principio de arquitectura (NO negociable)

**El LLM nunca calcula: redacta.** Todos los números (variaciones, medias, porcentajes) se calculan en código determinista sobre DynamoDB y se condensan en un JSON compacto. El LLM recibe SOLO ese JSON y redacta el resumen ejecutivo en español citando las cifras tal cual vienen — jamás recibe líneas crudas ni recalcula nada. Motivos: reproducibilidad (mismos datos → mismas cifras), coste (1 llamada corta por informe), y cero alucinación numérica.

## Contexto (verificado en el código)

- Integración OpenAI ya existente: `api/lib/ocrEnriquecerIa.js` (usa `OPENAI_API_KEY`, `DEFAULT_MODEL`, helper de disponibilidad). **Extraer el cliente HTTP común a `api/lib/ia/openaiClient.js`** y reutilizarlo desde OCR y desde estos asistentes. Temperatura baja (0.2) para informes.
- Compras persistidas en `Igp_ComprasAProveedor` (líneas de albarán aplanadas): `ProductId`, `ProductName`, `AlbaranFecha`, proveedor (`SupplierDocumentNumber`/serie), `Price`, `DiscountRate`, `CashDiscount`, `TotalAmount`, `Quantity`, **`PurchaseUnitName` (formato de compra)**, `FamilyId/FamilyName`, `LotNumber`. GSI por producto+fecha.
- Ventas por hora: `GET /api/agora/invoices/sales-by-hour` consulta Ágora **en vivo por día** — no sirve para análisis de rangos largos; la Fase 2 crea su agregado persistido.
- Patrones estándar: tablas en `api/lib/db.js` + scripts, cron con `X-Internal-Secret` (`api/lib/internalSync.js`), permisos `requirePermission` + `GRUPOS_PERMISOS` en `app/constants/modulos.ts`.

## Permisos

| Código | Qué habilita |
|---|---|
| `ia.informe_compras` | Ver/generar el informe IA de compras |
| `ia.informe_ventas_hora` | Ver/generar el informe IA de franjas horarias (Fase 2) |

Registrarlos en un grupo nuevo «Asistentes IA» de `GRUPOS_PERMISOS` y documentar en `api/ROLES-PERMISOS.md`.

## Tabla común `Igp_InformesIa`

```
PK        string — "TIPO#<compras|ventas_hora>"
SK        string — "PERIODO#<YYYY-MM-DD>_<YYYY-MM-DD>#<localId|GLOBAL>"
datosJson string — el JSON determinista que alimentó al LLM (auditoría y regeneración)
resumen   string — texto redactado por el LLM
modelo / generadoEn / generadoPor / costeTokens { prompt, completion }
```

Un informe generado se sirve de aquí (cache permanente); regenerar requiere `?force=1`.

---

# FASE 1 — Informe IA de compras (variaciones por proveedor, importe y formato)

## 1.1 Motor determinista `api/lib/ia/analisisCompras.js`

Función `analizarCompras({ dateFrom, dateTo, localId? })` sobre `Igp_ComprasAProveedor`. Compara el periodo con: (a) el periodo anterior de igual longitud y (b) la media de las 12 semanas previas. Detecta, por producto+proveedor+**formato** (`PurchaseUnitName`):

- **Variación de precio unitario neto** (Price con DiscountRate/CashDiscount aplicados): señalar |Δ| ≥ 5% vs periodo anterior o vs media 12s (umbral env `IA_COMPRAS_UMBRAL_PCT`, default 5).
- **Cambio de formato de compra**: mismo producto pasa de un `PurchaseUnitName` a otro → recalcular precio por unidad base cuando sea posible y señalarlo SIEMPRE (es donde se esconden subidas encubiertas).
- **Descuentos desaparecidos o reducidos** (DiscountRate/CashDiscount baja entre periodos).
- **Productos nuevos** y **productos que dejan de comprarse** (comprados en las 12s previas, ausentes en el periodo).
- **Impacto en €**: para cada variación, `(precioNuevo − precioAnterior) × unidades del periodo` = sobrecoste/ahorro. Ordenar por |impacto|.
- Totales por proveedor y por familia.

Salida: JSON compacto y tipado (máx ~50 hallazgos, ordenados por impacto; truncar el resto con contador). Este JSON es la única entrada del LLM.

## 1.2 Redacción LLM

Prompt de sistema (guardarlo en `api/lib/ia/prompts.js`, no inline): «Eres el analista de compras de un grupo de hostelería. Redacta en español un resumen ejecutivo breve del JSON adjunto: primero las 3-5 variaciones de mayor impacto en €, luego cambios de formato, luego descuentos perdidos, luego novedades. Cita siempre las cifras exactas del JSON. No inventes datos ni calcules nada nuevo. Cierra con las 2-3 acciones recomendadas (renegociar, pedir explicación al proveedor, buscar alternativa).»

## 1.3 Endpoint y pantalla

- `GET /api/ia/compras/informe?dateFrom=&dateTo=&localId=&force=` (`requirePermission('ia.informe_compras')`) — sirve de `Igp_InformesIa` o genera (motor → LLM → guardar). Si `OPENAI_API_KEY` no está configurada: devolver el JSON determinista con `resumen: null` y la UI muestra la tabla sin narrativa (el módulo funciona sin IA).
- **Cron semanal** (lunes por la mañana): genera el informe de la semana cerrada por local y global.
- Pantalla en Compras (`app/(app)/compras/informe-ia.tsx`): texto del resumen arriba + tabla de hallazgos debajo (producto, proveedor, formato, precio antes/después, Δ%, impacto €), filtros de periodo y local. Chip «Generado por IA» con fecha y botón regenerar (`force=1`).

## Criterios de aceptación Fase 1

- Una subida del 8% en un producto aparece en el JSON con su impacto en € y citada con esas mismas cifras en el resumen.
- Un cambio de `PurchaseUnitName` aparece señalado aunque el precio por albarán no varíe.
- Pedir dos veces el mismo periodo no llama dos veces al LLM (cache) salvo `force=1`.
- Sin `OPENAI_API_KEY`: la pantalla muestra la tabla de hallazgos sin resumen, sin errores.
- Sin `ia.informe_compras`: 403 y sin entrada de menú.

---

# FASE 2 — Variaciones de facturación por hora

## 2.1 Agregado persistido `Igp_VentasHora`

```
PK "LOCAL#<localId>" · SK "DIA#<YYYY-MM-DD>#H#<00-23>"
Fecha · Hora · WorkplaceId · ImporteBruto · NumTickets · SyncedAt
```

Sync nocturno (patrón `X-Internal-Secret` + throttle) reutilizando el mismo export de facturas que ya usa `sales-by-hour`, con `full-sync` de rango para cargar histórico (mínimo 8 semanas antes de activar informes). Idempotente por día (recalcula y sobreescribe).

## 2.2 Motor determinista `api/lib/ia/analisisVentasHora.js`

`analizarVentasHora({ dateFrom, dateTo, localId })`:
- Patrón de referencia por (día de semana × hora): mediana de las 8 semanas previas.
- Señalar franjas con |Δ| ≥ 20% vs su referencia (env `IA_VENTAS_HORA_UMBRAL_PCT`) y con importe de referencia mínimo (env, default 100 € — no alertar sobre franjas residuales).
- Agrupar horas contiguas en franjas con nombre legible («viernes 23:00–02:00»); si hay plantillas de franjas horarias configuradas (`/agora/franjas-plantillas`), usarlas para etiquetar turnos.
- Marcar posibles causas conocidas cruzando datos internos: festivo/estimación de `Igp_Gestionfestivosyestimaciones`, actuación o activación programada ese día — se añaden como `contexto` al JSON para que el LLM las mencione, no las invente.

## 2.3 LLM + pantalla

- Mismo esquema: JSON → resumen («El sábado el tramo 20:00–22:00 cayó un 28% (−640 €) frente a su patrón; había actuación programada que se canceló…»), cache en `Igp_InformesIa`, cron semanal.
- Pantalla en Cajas (`app/(app)/cajas/informe-horas-ia.tsx`): resumen + heatmap simple día×hora (verde/rojo según desviación) + lista de franjas señaladas.

## Criterios de aceptación Fase 2

- Una caída del 30% en una franja de viernes aparece con su € de impacto y su referencia de 8 semanas.
- Franjas con referencia < mínimo no generan alertas.
- Si la franja coincide con festivo/actuación registrada, el JSON lleva ese contexto y el resumen lo menciona.

---

## Reglas no opcionales

1. El LLM solo recibe JSON agregado; nunca líneas crudas, nunca datos personales (nombres de empleados, clientes).
2. Cada informe guarda su JSON fuente: cualquier cifra del texto debe poder rastrearse al dato.
3. Cache primero: un periodo ya generado no vuelve a llamar al LLM sin `force`.
4. Todo funciona sin API key (modo tabla sin narrativa) — la IA es capa opcional, no dependencia.
5. Registrar coste en tokens por informe en `Igp_InformesIa` (visibilidad del gasto).

## Mejoras futuras (NO implementar)

Asistente conversacional de seguimiento («¿por qué subió el vino X?») con contexto acotado al JSON del informe · informe diario narrado sobre el informe-diario existente · borradores de respuesta a reseñas (módulo Mystery Guest) · alertas push cuando un hallazgo supere un impacto configurable.
