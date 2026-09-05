# Auditoría de seguridad completa — ERP (Expo/React Native + API Express)

> Pega este prompt en Cursor (modo Agent, con el repo abierto). Está diseñado para una revisión de seguridad **de solo lectura**: no debe modificar código ni exponer secretos.

---

Actúa como un **ingeniero senior de ciberseguridad (AppSec)** especializado en aplicaciones web/móvil y APIs Node.js. Vas a realizar una **auditoría de seguridad completa** de esta aplicación y entregarme un **informe** con los hallazgos.

## Contexto de la app
- **Frontend:** Expo / React Native (carpeta `app/`) que también compila a web (`react-native-web`, `expo-router`, `react-native-webview`).
- **Backend:** API Express (carpeta `api/`) con `jsonwebtoken` (JWT), `bcrypt`, `helmet`, `cors`, `express-rate-limit`, `pino`.
- **Datos/infra:** AWS DynamoDB (`@aws-sdk/lib-dynamodb`), S3 con URLs prefirmadas, `multer` (subida de archivos), OCR (`tesseract.js`, `pdf-parse`, `pdfjs-dist`), `xlsx`/`exceljs`, `nodemailer`, e integración con un ERP externo (**Ágora**) y APIs de Google/Geo.
- **Dominio:** ERP financiero (facturación, remesas/pagos, cashflow, pedidos, roles y permisos). **El impacto de un fallo es alto.**

## Reglas de la auditoría (IMPORTANTE — respétalas estrictamente)
1. **Modo solo-lectura / auditoría.** NO modifiques, refactorices ni crees código ni ficheros de configuración. Tu único entregable es el informe.
2. **No expongas secretos.** No imprimas ni copies valores de claves, tokens, contraseñas, credenciales AWS/Ágora, ni el contenido de `.env`/`.env.local`. Si detectas un secreto expuesto o hardcodeado, indica **solo** el fichero y la línea y describe el riesgo, **sin revelar el valor**.
3. **Precisión sobre volumen.** No inventes hallazgos. Cada hallazgo debe apuntar a `fichero:línea` concreto y ser verificable. Si algo es una sospecha no confirmada, márcalo como "requiere verificación manual".
4. Revisa **todo el repositorio** relevante (`app/` y `api/`), no solo una muestra.

## Áreas a revisar

### 1. Autenticación y sesión (JWT)
- Fuerza y origen del secreto de firma (¿hardcodeado?, ¿suficientemente largo?, ¿desde entorno?).
- Algoritmo fijado explícitamente al verificar (evitar `alg:none` y confusión de algoritmos); expiración (`exp`) presente y razonable.
- Flujo de login, refresh y logout: ¿se invalidan los tokens?, ¿hay protección contra fuerza bruta en login?
- Almacenamiento del token en el cliente (AsyncStorage no está cifrado): ¿qué se guarda y cómo?
- Uso de `bcrypt`: cost factor adecuado, y que nunca se devuelva el hash en respuestas de la API.

### 2. Autorización y control de acceso (prioridad máxima)
- Que **cada** ruta sensible valide permisos/roles en el **backend** mediante middleware, no solo ocultando opciones en el frontend.
- **IDOR / BOLA:** endpoints que reciben un `id` (pedido, factura, empresa, local, usuario) sin comprobar que pertenece al tenant/usuario autenticado.
- **Aislamiento multi-tenant:** filtrado por empresa/local en todas las consultas a DynamoDB; buscar consultas que no filtren por el propietario.
- Escalada de privilegios: endpoints administrativos accesibles por roles inferiores; rutas sin middleware de auth.
- Enumera las rutas de `api/routes/` e indica cuáles carecen de comprobación de autenticación o de autorización.

### 3. Fugas de datos (data exposure)
- Respuestas que devuelven más campos de los necesarios (hashes, datos internos, PII, datos de otros tenants).
- Logs de `pino`/`pino-http` que registren tokens, contraseñas, PII o cuerpos completos de peticiones.
- Manejo de errores: stack traces o mensajes internos devueltos al cliente en producción.
- URLs prefirmadas de S3: alcance (objeto concreto), método y expiración; buckets/objetos accesibles sin control.
- Endpoints públicos que expongan datos sin autenticación.

### 4. Inyección y validación de entrada
- Validación/saneado de payloads en cada endpoint (¿se confía en el body sin validar?).
- Inyección NoSQL en filtros/expresiones de DynamoDB (`FilterExpression`, `KeyConditionExpression`) construidas con entrada de usuario.
- **Subida de archivos (`multer` + OCR + `pdf-parse` + `xlsx`/`exceljs`):** validación de tipo MIME real, tamaño máximo, saneado del nombre, **path traversal**, y parsing de ficheros maliciosos (XXE, zip-bombs, PDFs manipulados).
- Inyección en generación de PDFs/Excel (fórmulas CSV/Excel injection) y en cuerpos de correo (`nodemailer`, header/HTML injection).

### 5. Superficie web, cabeceras y cliente
- Configuración de `helmet`: cabeceras de seguridad activas (CSP, HSTS, etc.).
- Configuración de `cors`: que no combine `origin: *` con credenciales; lista blanca de orígenes.
- Rate limiting: aplicado realmente a login y endpoints sensibles (no solo declarado).
- XSS en la parte web y en `react-native-webview` (contenido dinámico, `injectedJavaScript`, `dangerouslySetInnerHTML`/`html-to-image`).
- Deep links / `expo-linking`: manejo de parámetros no confiables.

### 6. Secretos y configuración
- Claves o credenciales hardcodeadas en el código (solo señala ubicación, no el valor).
- Variables `EXPO_PUBLIC_*`: confirmar que **ninguna** contiene secretos de servidor (todo lo `EXPO_PUBLIC_` se empaqueta en el bundle del cliente y es público).
- Que `.env`, `.env.local` y credenciales estén en `.gitignore` y **no** hayan sido commiteadas (revisa el historial si es posible).
- Configuración de AWS: principio de mínimo privilegio en el uso del SDK.

### 7. Dependencias
- Ejecuta (o razona sobre) `npm audit` en la raíz y en `api/`, y lista los CVEs relevantes con severidad y versión afectada.
- Presta atención especial a librerías con historial de vulnerabilidades: `xlsx`, `pdf-parse`, `jspdf`, `pdfjs-dist`.

### 8. Integraciones y operaciones de dinero
- Módulo de **remesas / ejecutar-pago** y facturación: autorización reforzada, **idempotencia** (evitar dobles pagos/cargos), y trazabilidad/auditoría de acciones sensibles.
- **SSRF / open redirect** en llamadas salientes (Ágora, Google Maps/Geo): URLs construidas con entrada de usuario.
- Manejo de credenciales de las integraciones y validación de las respuestas externas antes de confiar en ellas.

## Formato del entregable (informe)
Genera un único informe en Markdown llamado `INFORME-SEGURIDAD-<fecha>.md` con esta estructura:

1. **Resumen ejecutivo** — estado general de fiabilidad de la app y los 3–5 riesgos más importantes, en lenguaje claro.
2. **Tabla de hallazgos** ordenada por severidad: `ID | Severidad | Área | Fichero:línea | Descripción | Recomendación`.
3. **Detalle por hallazgo**, agrupado por severidad **Crítico / Alto / Medio / Bajo**, cada uno con:
   - Qué es y por qué es un riesgo (impacto concreto en este ERP).
   - Ubicación exacta (`fichero:línea`).
   - Cómo se explotaría (vector de ataque).
   - Remediación recomendada (sin aplicarla).
4. **Fugas de datos detectadas** — sección específica: qué dato se expone, dónde y a quién.
5. **Estado de dependencias** — resumen de `npm audit`.
6. **Fiabilidad general** — valoración final y las 5 acciones prioritarias a abordar primero.

Empieza mapeando la estructura del proyecto y las rutas de la API, y luego procede área por área. **No modifiques nada; solo produce el informe.**
