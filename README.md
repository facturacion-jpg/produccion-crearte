# Producción | Crearte By Confeccionarte SAS

Aplicación estática para control de fichas técnicas, salidas y solicitudes a talleres externos.

## Arquitectura de despliegue

- **Frontend:** sitio estático (HTML + CSS + JS). Se publica en **GitHub Pages** desde la rama `main`. Render queda como alternativa con `render.yaml`.
- **Datos:** Firebase Realtime Database (sincronización PC ↔ celular). `localStorage` funciona como respaldo local.
- **Correo y PDF:** Google Apps Script publicado como *Web App*. No se necesita servidor propio.

No hay código de backend que compilar: GitHub Pages solo sirve archivos.

## Estructura

```
index.html            Interfaz completa (portales, tablas y modales)
firmar.html           Página pública para la firma de recibido de la planta
css/tailwind.css      Tailwind compilado (estilos de toda la interfaz)
css/tailwind.src.css  Fuente de Tailwind usada para recompilar
css/fonts.css         Tipografía Inter servida localmente
css/styles.css        Reglas propias e impresión de remisiones
fonts/                Archivos woff2 de Inter (latin y latin-ext)
img/logo.png          Logotipo usado en cabecera y remisiones
js/vendor/lucide.min.js  Iconos Lucide locales
js/config.js          URLs, token y configuración de Firebase  <-- editar al desplegar
js/storage.js         Persistencia, Firebase y envío al Script
js/app.js             Lógica de la interfaz
render.yaml           Blueprint opcional para Render (alternativa a GitHub Pages)
```

## Estilos locales (sin CDN)

La interfaz **no depende de internet** para verse correctamente: Tailwind, la tipografía Inter y los iconos Lucide se sirven desde el propio proyecto. Esto evita que la página aparezca “sin estilos” cuando `cdn.tailwindcss.com`, Google Fonts o unpkg no están disponibles.

Si agregas clases nuevas de Tailwind en `index.html`, `firmar.html` o `js/app.js`, hay que **recompilar** `css/tailwind.css` antes de desplegar. Con el CLI standalone de Tailwind 3.4.16:

```powershell
$exe = "$env:TEMP\tailwindcss-v3.4.16.exe"
Invoke-WebRequest -Uri "https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.16/tailwindcss-windows-x64.exe" -OutFile $exe
& $exe -i "css/tailwind.src.css" -o "css/tailwind.css" --content "./index.html,./firmar.html,./js/**/*.js" --minify
```

No hace falta subir el ejecutable: solo se genera `css/tailwind.css`.

## Checklist antes de desplegar

### 1. Repositorio

GitHub Pages despliega desde Git. Si aún no tienes repositorio:

```bash
git init
git add .
git commit -m "Versión inicial para despliegue"
git remote add origin URL_DE_TU_REPO
git push -u origin main
```

### 2. GitHub Pages (despliegue actual)

- En el repositorio: **Settings → Pages → Source: Deploy from a branch**.
- Rama: `main`, carpeta `/ (root)`, luego **Save**.
- URL pública: `https://facturacion-jpg.github.io/produccion-crearte/`.
- Esa URL ya está fijada en `js/config.js` → `APP_SYSTEM.publicBaseUrl` (sin barra final). También se puede cambiar desde **Gestión Central → Configuración → Enlaces de firma electrónica**.
- Se usa para armar el enlace de firma que recibe la planta: `https://facturacion-jpg.github.io/produccion-crearte/firmar.html?...`.

#### Alternativa: Render (Static Site)

- *New* → **Static Site**.
- Repositorio y rama: `main`.
- **Root Directory:** la carpeta donde está `index.html` (normalmente `.`).
- **Build Command:** vacío.
- **Publish Directory:** `.`.
- O alternativamente usa `render.yaml` con *Deploy from blueprint*.
- Si publicas en Render, cambia `APP_SYSTEM.publicBaseUrl` por la URL que te dé Render (sin barra final).

> Todas las rutas del proyecto son relativas (`css/...`, `js/...`, `img/...`), así que funciona tanto en la raíz como en un subdirectorio.

### 3. Firebase

1. Crear/verificar el proyecto en Firebase Console.
2. Crear una **Realtime Database**.
3. En `js/config.js`, confirmar que `FIREBASE_CONFIG` corresponde a ese proyecto.
4. Activar **Authentication → Sign-in method → Anonymous**.
   Solo se usa como respaldo mientras la cuenta de servicio no esté configurada; la app y la firma pública autentican con custom tokens.
5. Configurar la cuenta de servicio. **Método recomendado: IAM `signBlob`, sin llave privada.**
   - Firebase Console → **Project settings** → **Service accounts**. Copia el correo `firebase-adminsdk@...`.
   - En Apps Script → **Configuración del proyecto → Propiedades de script**, agrega:
     - `FIREBASE_SERVICE_CLIENT_EMAIL`: ese correo.
   - En el proyecto de Google Cloud del Apps Script:
     - Habilita **IAM Credentials API**.
     - En **IAM y administración → Cuentas de servicio**, selecciona `firebase-adminsdk@...` → **Permisos** → **Conceder acceso**.
     - Principal: el correo del dueño del Apps Script. Rol: **Service Account Token Creator** (`iam.serviceAccounts.signBlob`).
   - En `appsscript.json` (Configuración del proyecto → **Mostrar archivos de manifiesto**) agrega el scope `https://www.googleapis.com/auth/iam` conservando los demás scopes del archivo `google-apps-script/appsscript.json` de este repo.
   - Ejecuta una vez `probarTokenFirebase()` desde el editor. En *Registros* debe decir **Custom token de Firebase generado correctamente**.
6. Método alternativo solo si tu organización permite descargar llaves: generar la llave privada y agregar `FIREBASE_SERVICE_PRIVATE_KEY`. El código usa esa llave si existe; si no, usa `signBlob`. La llave nunca se sube a GitHub ni viaja al navegador.
7. Volver a publicar el Web App de `AuthWebApp.gs` (**Deploy → New version**) y ejecutar una vez `inicializarAuth()` para crear la hoja `FirmasPublicas`.
8. Confirmar que el login funcione y que `firmar.html` abra un enlace existente.
9. Solo entonces publicar las reglas de `firebase.rules.json` en **Realtime Database → Rules**.

Las reglas nuevas exigen custom token:

- Usuarios con login: `auth.token.rol` y `auth.token.planta_id`.
- `LECTURA`: solo lectura.
- `ADMIN`: config, plantas, fichas, solicitudes y firmas.
- `FICHAS`: fichas y solicitudes.
- `TELAS` / `INSUMOS`: solicitudes (despachos).
- `PLANTA`: solicitudes y lectura general.
- Firma pública: token con `auth.token.firma === true`, válido únicamente para `ficha_id` y `tipo` autorizados.

Con las reglas antiguas (`.read: "auth != null"`, `.write: "auth != null"`) cualquier visitante podía usar la API de Firebase directamente. Con reglas públicas (`.read: true`, `.write: true`) cualquiera podía leer o borrar los datos.

Los datos se guardan bajo `crearte_produccion/{produccion_config|produccion_plantas|produccion_fichas|produccion_solicitudes|produccion_firmas|produccion_firmas_despachos}`.
La firma de la salida inicial se guarda aparte, en `crearte_produccion/produccion_firmas/{idFicha}`, y la firma de cada despacho de material en `crearte_produccion/produccion_firmas_despachos/{idSolicitud}`. Así no se reescribe la ficha ni la solicitud desde el celular de la planta. La plataforma escucha ambos nodos y muestra la evidencia automáticamente.

Si no quieres acumular histórico, crea una limpieza programada desde Apps Script (no existe cron en un sitio estático).

### 4. Google Apps Script

1. Crear un proyecto de Apps Script y publicarlo como **Web app**:
   - *Execute as:* el dueño del script.
   - *Who has access:* **Anyone**.
2. Implementar `doPost(e)` para recibir el JSON, validar el token y enviar el correo con los adjuntos.
3. Copiar la URL `.../exec` a `APP_SYSTEM.apiCorreoPdfUrl` en `js/config.js`.
4. Configurar la propiedad de script `API_TOKEN` en **Configuración del proyecto → Propiedades de script** y poner el mismo valor en `APP_SYSTEM.tokenIntegracion`. Ya está configurado; si cambias el token, actualiza ambos sitios.

El proyecto `Auth Produccion Crearte` (`google-apps-script/AuthWebApp.gs`) además debe tener:

```text
USUARIOS_SPREADSHEET_ID       = ID de "Usuarios Produccion Crearte"
USER_SETUP_KEY                = clave de alta del primer usuario
AUTH_SECRET                   = se genera solo
FIREBASE_SERVICE_CLIENT_EMAIL = correo firebase-adminsdk@... de la cuenta de servicio
FIREBASE_SERVICE_PRIVATE_KEY  = OPCIONAL; solo si se permite descargar llaves
```

Después de pegar el código actualizado y el `appsscript.json`, autoriza el nuevo scope ejecutando `probarTokenFirebase()` desde el editor. Luego crea una nueva versión del Web App y ejecuta `inicializarAuth()` una vez. Eso crea la pestaña `FirmasPublicas` en la misma hoja de usuarios.

El formulario de ficha de salida admite **dos archivos**: Ficha Técnica y Salida de Insumos. Ambos se envían en `adjuntosPdf` (arreglo). `adjuntoPdf` se mantiene solo para compatibilidad con versiones anteriores.

El correo incluye el enlace público `firmar.html?id=...&token=...` y el campo `firmaUrl` en el payload; para despachos el enlace es `firmar.html?tipo=despacho&id=...&token=...`. También incluye una línea **PORTAL DE PRODUCCIÓN** con la URL pública de la app para que la persona pueda entrar con su usuario y clave desde el correo. La versión publicada del Script genera además un `htmlBody` con el botón **Firmar recibido**. El enlace solo funciona si la URL pública está configurada en *Configuración* o en `js/config.js`. El Script debe aceptar los nuevos `tipoEvento`: `DESPACHO_MATERIAL_FIRMA` y `COBRO_CONTABILIDAD`.

```javascript
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const tokenEsperado = PropertiesService.getScriptProperties().getProperty("API_TOKEN");
    if (tokenEsperado && data.token !== tokenEsperado) throw new Error("Token inválido");

    if (data.dryRun) return json_({ ok: true, dryRun: true });

    const opciones = { cc: data.cc || "", name: data.empresa || "Crearte" };
    const adjuntos = (data.adjuntosPdf || [])
      .filter(a => a && a.base64)
      .map(a => Utilities.newBlob(
        Utilities.base64Decode(a.base64),
        a.mimeType || "application/pdf",
        a.nombre || "Adjunto.pdf"
      ));
    if (adjuntos.length) opciones.attachments = adjuntos;

    GmailApp.sendEmail(data.para, data.asunto, data.cuerpo, opciones);
    return json_({ ok: true, adjuntosEnviados: adjuntos.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

El token viaja en el código del navegador: sirve como filtro básico, **no como secreto**. Para mayor seguridad, valida el origen de la petición o añade autenticación.

> Nota: Apps Script no expone cabeceras CORS. `js/storage.js` usa `mode: "no-cors"`, por lo que el correo se envía pero la app no puede confirmar la respuesta del Script. No reintentar automáticamente para evitar correos duplicados.

### 5. Firma de recibido y plazo de novedades

- La remisión muestra una **firma automática del despachador** con el nombre configurado en *Configuración → Bodega de Telas → Nombre para la firma automática del despachador*.
- La planta recibe un enlace único en el correo. Al abrirlo puede dibujar la firma, escribir nombre, cédula y cargo, y confirmar el recibido.
- En ese mismo enlace debe marcar **Recibido (Sí/No)** y **Estado** en cada ítem de la Orden de Salida Inicial; puede añadir una observación o novedad por ítem. El formulario exige completar ambos campos en todos los materiales antes de guardar.
- La firma **y los ítems confirmados** se guardan en Firebase (`crearte_produccion/produccion_firmas/{idFicha}`, campos `items` e `itemsConfirmadosAt`). No se reescribe la ficha completa desde el celular de la planta, para no sobrescribir cambios simultáneos de Gestión Central.
- La plataforma escucha ese nodo e integra los valores en la remisión, los listados y la exportación CSV en tiempo real. Si se configuró `panelCentralUrl`, además se envía el evento `FIRMA_RECIBIDO_ITEMS`.
- Si una ficha antigua no tiene enlace, abre su remisión y pulsa **Generar enlace de firma**.
- El plazo es de **dos días hábiles**. El cálculo excluye sábados y domingos, pero **no descuenta festivos**. Si se necesitan festivos, se debe ampliar `calcularFechaLimiteNovedades()` en `js/app.js`.

### 6. Reporte de avance por talla

- En *Planta Externa*, **Reportar Avance** abre una tabla de tallas. La planta digita la talla (no está limitada a una lista fija: puede escribir `44`, `Manga Especial`, etc.) y las unidades terminadas de cada una; puede agregar o quitar filas.
- El modal muestra en vivo el **total reportado** y el **porcentaje** sobre las unidades totales de la orden (`cantidadPrendas`). Ese total es la suma de las tallas y se guarda en `unidadesTerminadas` para conservar los cálculos y reportes existentes.
- El desglose se persiste en cada ficha como `avancesPorTalla` (`[{ talla, unidades, fecha }]`) dentro de `crearte_produccion/produccion_fichas`, por lo que sincroniza con Firebase junto con la ficha.
- Al hacer clic en la barra de avance, tanto en *Gestión Central* como en *Planta Externa*, se abre **Avance por talla** con el total, la meta, el porcentaje, unidades por talla, porcentaje de cada talla y fecha del último reporte. Desde ese desglose la planta puede volver a editar el avance.
- La remisión y la exportación CSV también incluyen el desglose por talla.
- Fichas creadas antes de este cambio conservan su total: al abrir el modal se coloca ese valor en una fila para que la planta le asigne la talla correspondiente.

### 7. Solicitudes de material y cobro fuera de plazo

- Desde **Pedir Material** se carga automáticamente la **referencia** de la ficha. El campo **Lote / Orden de Producción** se deja vacío porque lo digita quien solicita el material.
- Motivos disponibles: Reposición de materiales, **FALTANTE DESDE ORIGEN** (antes “Faltante detectado en confección”), Ampliación de lote, Cambio de especificación, **DESPERDICIO**, **DAÑO DE CONFECCION** y **PERDIDA DEL INSUMO**.
- Al radicar la solicitud, el sistema la compara con la ficha de origen y la marca **Fuera del plazo de dos días** cuando ya venció el plazo de dos días hábiles para reportar novedades.
- En *Bandeja de Despachos*, esas solicitudes muestran la alerta. Al abrir **Despachar**, el encargado de Telas o Insumos ve un recuadro de cobro y debe marcar **Autorizar cobro a Contabilidad** si procede.
- Solo con ese check, al confirmar el despacho se envía automáticamente un correo (`tipoEvento: COBRO_CONTABILIDAD`) al correo configurado en *Configuración → Contabilidad*, con planta, referencia, lote, motivo, responsable, remisión y materiales despachados. También se notifica el panel central si está configurado.
- El destinatario se configura en `js/config.js` (`contabilidadNombre`, `contabilidadEmail`) y se puede editar en *Configuración*. Si el correo falla, el despacho queda registrado y se avisa en pantalla.

#### Firma del material despachado

- Sí: cuando Telas o Insumos confirma un despacho, se envía además un correo (`tipoEvento: DESPACHO_MATERIAL_FIRMA`) a la planta solicitante (correo registrado en su ficha del panel de plantas), con copia a Ingeniería y al área que despachó.
- Ese correo trae el enlace `firmar.html?tipo=despacho&id=...&token=...` para que la planta confirme **Recibido (Sí/No)** y **Estado** de cada material, agregue observaciones y dibuje su firma. El token se genera al despachar y queda guardado en la solicitud.
- La firma se guarda en `crearte_produccion/produccion_firmas_despachos/{idSolicitud}`. Los listados muestran **Recibido firmado: nombre**; antes de firmar muestran un enlace **Firmar recibido** solo al usuario `PLANTA` dueño de esa solicitud, y la remisión incluye la firma de la planta y la del despachador del área correspondiente. ADMIN y LECTURA ven el estado **Pendiente de firma por ...**, pero no pueden abrir el formulario de firma desde la interfaz.
- Si la planta no tiene correo configurado, el despacho se registra igual y se avisa en consola; el enlace queda disponible al abrir la remisión.
- Para que el botón llegue al correo, configura la **URL pública del sitio** en *Configuración → Enlaces de firma electrónica* (o `publicBaseUrl` en `js/config.js`).

### 8. Login con Google Sheets y roles

El acceso usa una hoja de Google Sheets del Workspace, sin Firebase Authentication. La app llama a un Web App de Apps Script (`google-apps-script/AuthWebApp.gs`) que lee/escribe la hoja **Usuarios**. La clave nunca se guarda en texto plano: se almacena `salt + SHA-256` y la sesión es un token HMAC con vigencia de 12 horas.

#### Puesta en marcha

1. Crea en Google Drive un spreadsheet de usuarios (puede estar en el mismo Workspace del correo).
2. Crea un proyecto de Apps Script nuevo y pega todo `google-apps-script/AuthWebApp.gs`.
3. En **Configuración del proyecto → Propiedades de script**, agrega:
   - `USUARIOS_SPREADSHEET_ID`: el ID del spreadsheet del paso 1.
   - `FIREBASE_SERVICE_CLIENT_EMAIL`: el correo de la cuenta de servicio indicado en la sección de Firebase (`FIREBASE_SERVICE_PRIVATE_KEY` solo si se permite descargar llaves).
4. En el editor de Apps Script ejecuta una sola vez `inicializarAuth()` y autoriza. En *Registros/Logs* verás la URL de la hoja y la `USER_SETUP_KEY`.
5. Publica el script como **Web app**:
   - *Execute as:* el dueño del script.
   - *Who has access:* **Anyone**.
6. Copia la URL `.../exec` y pégala en `APP_SYSTEM.apiAuthUrl` dentro de `js/config.js`.
7. Recarga la app. En el primer acceso abre la pestaña **Crear usuario**, digita la `USER_SETUP_KEY` y crea el usuario `ADMIN`. A partir de ahí, los usuarios nuevos los crea ese administrador desde el botón **+** que aparece en la barra superior.

Estado actual del despliegue:

- Web App de login: `https://script.google.com/macros/s/AKfycbw9mU3jE4Z-Y8xPKxIZHsuVBPUUskQwlQOgYNJN1koDYGmJBMXEHoIrCTvk3E2sIgQi/exec`
- Hoja de usuarios: `https://docs.google.com/spreadsheets/d/1Efb3Aa5lJhfq7FyYNQSNFfWOqoRHl6lr_vi895QDf7k/edit`
- Ya existe el usuario `ADMIN` creado con la hoja; los accesos nuevos los da ese administrador.

> Nota técnica: Apps Script no permite CORS y envía `X-Frame-Options`, así que el navegador no puede leer la respuesta del Web App. El cliente envía la acción con `navigator.sendBeacon` (o `fetch` de respaldo) y obtiene el resultado con JSONP usando un nonce. La clave viaja en el cuerpo de un POST, nunca en la URL.

Si `APP_SYSTEM.apiAuthUrl` queda vacío, el login se desactiva y la app entra directamente (útil mientras terminas la configuración).

#### Cómo crear usuarios y ligarlos a una planta

1. Entra como **ADMIN**.
2. En la barra negra superior aparece un botón **+** junto a tu nombre. Púlsalo para abrir **Crear usuario**.
3. Llena:
   - **Usuario para entrar**: el nombre con el que hará login, sin espacios (ejemplo: `planta.norte`).
   - **Nombre completo** y **Correo** (opcional): solo para identificar a la persona.
   - **Rol del usuario**: define lo que puede hacer. En la tarjeta aparece una explicación debajo del desplegable.
   - **Planta asignada**: aparece solo cuando eliges el rol **Planta externa**. Selecciona la planta real (por ejemplo, *Taller Aliado Norte (Bello)*).
   - **Clave inicial**: mínimo 6 caracteres. Entregasela al usuario; en la hoja se guarda cifrada.
4. Pulsa **Crear usuario**. El usuario ya puede entrar con esa usuario y clave.

La planta queda guardada en la columna `planta_id` de la hoja **Usuarios** (por ejemplo, `PLT-01`). Un usuario `PLANTA` solo ve el portal y las solicitudes de esa planta. Si el rol no es `PLANTA`, el campo de planta no aparece y `planta_id` queda vacío.

Para cambiar la planta de alguien, edita `planta_id` en la hoja o elimina y vuelve a crear el usuario. Para desactivarlo, cambia `activo` a `NO`.

#### Cómo decir qué usuario es cada rol

En **Crear usuario** eliges el rol en el desplegable. Después puedes cambiarlo directamente en la columna `rol` de la hoja **Usuarios** y recargar la app:

| Rol en la hoja | Usuario para | Qué puede hacer |
| --- | --- | --- |
| `ADMIN` | Administrador | Todo: fichas, despachos, configuración y alta de usuarios. |
| `FICHAS` | Quien envía las fichas y las salidas de insumos | Crear/enviar **Ficha Técnica + Salida Inicial**, reportar avance y pedir material. |
| `TELAS` | Bodega de Telas | Ver y despachar **solo** solicitudes de Telas. |
| `INSUMOS` | Almacén de Insumos | Ver y despachar **solo** solicitudes de Insumos. |
| `PLANTA` | Planta externa | Solo el portal de **su** planta; reportar avance y pedir material. Requiere `planta_id` (`PLT-01`, etc.). |
| `LECTURA` | Solo consulta | Ve todos los listados y remisiones, pero no ve formularios ni botones que editen o envíen. |

Columnas de la hoja: `usuario | nombre | correo | rol | planta_id | activo | salt | clave_hash | creado_at | creado_por`. Para desactivar a alguien, cambia `activo` a `NO`. Para resetear su clave, puede hacerlo él desde el Web App o un `ADMIN`.

> `firmar.html` sigue siendo público: la planta firma desde el enlace con `id + token`, sin login.

### 9. Verificación posterior al despliegue

- [ ] La URL de GitHub Pages carga sin errores en consola.
- [ ] La interfaz se ve con estilos aunque no haya internet (Tailwind, Inter y Lucide son locales).
- [ ] El logo y los iconos se ven.
- [ ] Cambiar entre *Gestión Central* y *Planta Externa*.
- [ ] Crear una ficha de prueba y revisar que la tabla tenga las seis filas: Bultos de piezas cortadas, Plantillas y Molderia, Set de tallas, Retazo de tela, Insumos y etiquetas y Muestra Fisica.
- [ ] Adjuntar Ficha Técnica y Salida de Insumos; revisar que ambos nombres aparezcan en la previsualización.
- [ ] Confirmar que el correo incluye el enlace, el botón **Firmar recibido** y la línea **PORTAL DE PRODUCCIÓN** con la URL pública.
- [ ] Abrir el enlace desde el celular, marcar **Recibido** y **Estado** en cada ítem, dibujar la firma y confirmar. La remisión debe mostrar la firma, el estado **Firmada** y los valores confirmados por la planta sin recargar la plataforma.
- [ ] Confirmar que la remisión muestra la firma automática del despachador y la nota de dos días hábiles.
- [ ] Confirmar que el correo llega con ambos PDF (la app no podrá confirmarlo por CORS).
- [ ] Probar desde el celular con otro dispositivo: los datos deben sincronizar si Firebase está bien configurado.
- [ ] Desde *Planta Externa*, reportar avance en dos tallas escritas libremente y confirmar que el total y el porcentaje siguen calculándose sobre el total de unidades de la orden.
- [ ] Hacer clic en la barra de avance en *Gestión Central* y en *Planta Externa*: debe abrirse el desglose por talla con total, meta y porcentaje.
- [ ] Verificar que el desglose aparezca también en la remisión y en el CSV exportado.
- [ ] Desde *Pedir Material*, confirmar que se carga la referencia y que el lote queda vacío para digitarlo el solicitante.
- [ ] Revisar que los nuevos motivos aparezcan y que ya no exista “Faltante detectado en confección”.
- [ ] Crear una solicitud fuera del plazo de dos días, despacharla marcando **Autorizar cobro a Contabilidad** y confirmar el correo al área configurada.
- [ ] Verificar que una solicitud dentro del plazo NO muestre el check de cobro ni envíe el correo.
- [ ] Despachar una solicitud y confirmar que la planta recibe el correo con el enlace **Firmar recibido** y el botón del Apps Script.
- [ ] Abrir ese enlace, marcar Recibido y Estado en cada material, firmar y verificar que el estado cambia a **Recibido firmado** en los listados y en la remisión.
- [ ] Publicar `AuthWebApp.gs`, configurar `USUARIOS_SPREADSHEET_ID` y pegar la URL `/exec` en `APP_SYSTEM.apiAuthUrl`.
- [ ] Configurar `FIREBASE_SERVICE_CLIENT_EMAIL`, el scope `iam` y el rol **Service Account Token Creator**; ejecutar `probarTokenFirebase()` y `inicializarAuth()`, y publicar una nueva versión del Web App.
- [ ] Entrar con un usuario y confirmar que Firebase recibe el custom token (sin errores `permission_denied`).
- [ ] Abrir un enlace de firma antiguo y uno nuevo; ambos deben cargar con `firmar.html` público.
- [ ] Publicar `firebase.rules.json` en Realtime Database y repetir la prueba de login y firma.
- [ ] Crear el primer usuario `ADMIN` con la `USER_SETUP_KEY` y confirmar que la hoja **Usuarios** tiene `salt` y `clave_hash`, nunca la clave en claro.
- [ ] Crear usuarios `TELAS`, `INSUMOS`, `FICHAS`, `PLANTA` y `LECTURA`; verificar que cada uno ve solo lo suyo.
- [ ] Confirmar que un usuario `LECTURA` no ve formularios ni botones de edición/despacho.
- [ ] Confirmar que `firmar.html?tipo=...&id=...&token=...` abre sin sesión.
- [ ] Verificar que las reglas de Firebase no estén abiertas.

## Limitaciones del esquema sin backend propio

- No hay secretos del lado servidor: todo lo que necesita el navegador es público.
- La validación de negocio vive en el cliente.
- No hay logs centralizados propios (solo los de Firebase y Apps Script).
- El envío de correo no tiene confirmación por CORS.
