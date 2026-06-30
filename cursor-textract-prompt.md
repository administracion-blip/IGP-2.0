# Prompt para Cursor: Integrar AWS Textract + Switch en Ajustes

## Contexto del proyecto

- Framework: React Native / Expo con backend Node.js/Express en `/api`
- OCR actual: `tesseract.js` (línea 44 de `api/routes/facturacion.js`)
- AWS ya configurado: `S3Client` apuntando al bucket `igp-2.0-files` en región `eu-west-3`
- Base de datos: DynamoDB. La tabla de ajustes (`tables.ajustes`) usa esquema PK/SK
- El módulo de ajustes ya existe: `app/(app)/ajustes.tsx` (frontend) y `api/routes/ajustes.js` (backend)

---

## Tarea 1 — Instalar el SDK de Textract en el backend

En `api/package.json`, añadir la dependencia:

```
@aws-sdk/client-textract
```

Ejecutar `npm install` en la carpeta `api/`.

---

## Tarea 2 — Crear helper de Textract (`api/lib/textractOcr.js`)

Crear el archivo `api/lib/textractOcr.js` con las siguientes responsabilidades:

1. Instanciar `TextractClient` con la misma región que el S3 existente (`process.env.AWS_REGION || 'eu-west-3'`).
2. Exportar una función `analizarFacturaConTextract(s3Bucket, s3Key)` que:
   - Llame a `AnalyzeExpenseCommand` de Textract usando `S3Object: { Bucket, Name: s3Key }` (no base64, usar la referencia S3 directa para evitar límites de tamaño).
   - Extraiga del resultado los campos `SummaryFields` y `LineItemGroups` relevantes: proveedor, NIF/CIF, fecha, número de factura, base imponible, porcentaje IVA, cuota IVA, recargo de equivalencia, retención IRPF y total.
   - Devuelva un objeto plano con esos campos en el mismo formato que ya usa `parseTextoFacturaCompleto` de `ocrFacturaEntidades.js`, para que el resto del pipeline de validación/enriquecimiento no cambie.
3. Exportar también una función `analizarTextoGeneralConTextract(s3Bucket, s3Key)` que use `DetectDocumentTextCommand` para imágenes sin estructura de factura, y devuelva el texto plano concatenado.

---

## Tarea 3 — Añadir el ajuste `ocr_textract_activo` en DynamoDB

El ajuste se guardará en la tabla `tables.ajustes` con:
- `PK: 'sistema'`
- `SK: 'ocr_textract_activo'`
- `valor: true | false`
- `updatedAt: <ISO string>`

Crear una función helper en `api/lib/db.js` (o al inicio de `facturacion.js`) llamada `getOcrTextractActivo()` que:
- Haga un `GetCommand` a esa clave.
- Devuelva `true` si el ítem existe y `valor === true`, `false` en cualquier otro caso.
- Cachee el resultado en memoria durante 60 segundos para no llamar a DynamoDB en cada OCR.

---

## Tarea 4 — Modificar el flujo OCR en `api/routes/facturacion.js`

Buscar el bloque donde se usa `Tesseract` (importado en línea 44 como `require('tesseract.js')`) y modificar el flujo de OCR de facturas así:

1. Antes de lanzar el OCR, llamar a `getOcrTextractActivo()`.
2. **Si está activo (true):**
   - Si la imagen ya está subida a S3 (lo está, porque el flujo actual sube a S3 primero), llamar a `analizarFacturaConTextract(S3_BUCKET, s3Key)`.
   - Usar el resultado directamente como entrada para `reconciliarFacturaOcr` y `aplicarPostProcesadoPipeline`, igual que se hace hoy con el texto de Tesseract.
   - Si Textract falla (try/catch), loggear el error y hacer fallback a Tesseract para no romper el flujo.
3. **Si está inactivo (false):**
   - Usar el flujo actual de Tesseract sin cambios.

No eliminar el código de Tesseract: dejarlo como fallback.

---

## Tarea 5 — Switch en el frontend `app/(app)/ajustes.tsx`

En `ajustes.tsx` ya hay componentes `Switch` de React Native. Añadir una nueva sección de configuración llamada **"Reconocimiento de documentos (OCR)"** con:

1. Un estado local `ocrTextractActivo: boolean` inicializado leyendo el ajuste desde la API (`GET /api/ajustes/sistema/ocr_textract_activo`).
2. Un componente `Switch` que al cambiar llame a `PATCH /api/ajustes/sistema/ocr_textract_activo` con el body `{ valor: boolean }`.
3. Mostrar junto al switch un texto descriptivo:
   - Cuando está ON: `"Escaneo con AWS Textract activado. Se aplicarán cargos por uso."`
   - Cuando está OFF: `"Escaneo desactivado. No se realizarán llamadas externas de OCR."`
4. Proteger la sección con el permiso `ajustes.sistema.ocr` (o el permiso equivalente que uses en el resto del módulo de ajustes para secciones de sistema). Si el usuario no tiene ese permiso, no mostrar la sección.
5. Mostrar un indicador de carga mientras se lee o guarda el ajuste.

Seguir el mismo patrón visual y de código que ya usan los otros switches de ajustes en el archivo.

---

## Restricciones importantes

- **No romper el flujo actual**: Tesseract sigue siendo el fallback. Si Textract falla o está desactivado, todo funciona igual que antes.
- **No cambiar la interfaz de retorno del OCR**: el resto del pipeline (`reconciliarFacturaOcr`, `enriquecerFacturaOcrConOpenAI`, `aplicarPostProcesadoPipeline`) debe recibir los mismos campos de siempre.
- **No hardcodear credenciales**: usar las variables de entorno AWS ya configuradas en el proyecto (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`).
- **No cambiar el modelo de datos de facturas**: solo se añade el ajuste `ocr_textract_activo` en la tabla de ajustes.
