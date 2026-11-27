// =============================================================================
// AuthWebApp.gs — Login de Producción Crearte con Google Sheets
// =============================================================================
// Publicar como Web App:
//   - Ejecutar como: el dueño del script (él puede editar la hoja).
//   - Quién tiene acceso: Cualquiera.
//   - Copiar la URL .../exec en js/config.js -> APP_SYSTEM.apiAuthUrl.
//
// Propiedades del proyecto (Apps Script -> Configuración del proyecto):
//   USUARIOS_SPREADSHEET_ID = ID de la hoja de Google Sheets de usuarios.
//   USER_SETUP_KEY          = clave única para dar de alta al PRIMER usuario.
//   AUTH_SECRET             = se genera sola; no la cambies sin cerrar sesiones.
//   FIREBASE_SERVICE_CLIENT_EMAIL = correo de la cuenta de servicio de Firebase.
//   FIREBASE_SERVICE_PRIVATE_KEY  = llave privada JSON de esa cuenta de servicio.
//
// La hoja de usuarios se llama "Usuarios" y se crea sola con estas columnas:
//   usuario | nombre | correo | rol | planta_id | activo | salt | clave_hash | creado_at | creado_por
//
// Roles válidos: ADMIN, FICHAS, TELAS, INSUMOS, PLANTA, LECTURA.
// Nunca guardes la clave en texto plano: se almacena salt + SHA-256.
// =============================================================================

const AUTH_SHEET_NAME = "Usuarios";
const FIRMAS_SHEET_NAME = "FirmasPublicas";
const AUTH_ENCABEZADOS = [
    "usuario", "nombre", "correo", "rol", "planta_id", "activo",
    "salt", "clave_hash", "creado_at", "creado_por"
];
const FIRMAS_ENCABEZADOS = [
    "id", "token", "tipo", "planta_id", "registro_json", "creado_at"
];
const AUTH_ROLES = ["ADMIN", "FICHAS", "TELAS", "INSUMOS", "PLANTA", "LECTURA"];

function doGet(e) {
    const params = (e && e.parameter) || {};
    if (String(params.accion || "") === "resultado") {
        return entregarResultado(String(params.nonce || ""), String(params.cb || ""));
    }
    return HtmlService.createHtmlOutput(
        "<pre>AuthWebApp activo. Use la URL /exec desde js/config.js (APP_SYSTEM.apiAuthUrl).</pre>"
    );
}

function doPost(e) {
    let data = {};
    try {
        if (e && e.parameter && e.parameter.payload) {
            data = JSON.parse(e.parameter.payload);
        } else if (e && e.postData && e.postData.contents) {
            data = JSON.parse(e.postData.contents);
        }
    } catch (err) {
        data = {};
    }

    let resultado;
    try {
        resultado = manejarAuth(data || {});
    } catch (err) {
        resultado = { ok: false, mensaje: String(err && err.message ? err.message : err) };
    }

    // El navegador no puede leer la respuesta (sin CORS y con X-Frame-Options),
    // así que guardamos el resultado unos segundos y se consulta por JSONP.
    const nonce = String((data && data.nonce) || "");
    if (nonce) {
        try {
            CacheService.getScriptCache().put(claveResultado(nonce), JSON.stringify(resultado), 60);
        } catch (err) {
            resultado = { ok: false, mensaje: "No se pudo guardar la respuesta. Intenta de nuevo." };
        }
    }
    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
}

function claveResultado(nonce) {
    return "crearte_auth_" + nonce;
}

// El cliente consulta con <script src>; la respuesta es JavaScript y se ejecuta
// dentro de la página de la app, sin depender de CORS ni de iframes.
function entregarResultado(nonce, cb) {
    const cache = CacheService.getScriptCache();
    const clave = claveResultado(nonce);
    const guardado = cache.get(clave);
    if (!guardado) {
        return responderJsonp({ nonce: nonce, pendiente: true }, cb);
    }
    cache.remove(clave);
    let resultado;
    try {
        resultado = JSON.parse(guardado);
    } catch (err) {
        resultado = { ok: false, mensaje: "Respuesta inválida del servidor." };
    }
    return responderJsonp({ nonce: nonce, pendiente: false, resultado: resultado }, cb);
}

function responderJsonp(objeto, cb) {
    const nombre = /^[A-Za-z0-9_$]+$/.test(String(cb || "")) ? String(cb) : "crearteAuthCb";
    const json = JSON.stringify(objeto)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\\u2028/g, "\\u2028")
        .replace(/\\u2029/g, "\\u2029");
    const js = "window." + nombre + "(" + json + ");";
    return ContentService.createTextOutput(js).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function manejarAuth(data) {
    const accion = String(data.accion || "");
    const datos = data.datos || {};

    if (accion === "login") return authLogin(datos);
    if (accion === "validar") return authValidar(datos);
    if (accion === "crear") return authCrear(datos);
    if (accion === "listar") return authListar(datos);
    if (accion === "cambiarClave") return authCambiarClave(datos);
    if (accion === "registrarFirma") return authRegistrarFirma(datos);
    if (accion === "tokenFirmaPublica") return authTokenFirmaPublica(datos);
    return { ok: false, mensaje: "Acción no reconocida." };
}

// -----------------------------------------------------------------------------
// Hoja y properties
// -----------------------------------------------------------------------------
function propiedad(nombre) {
    return PropertiesService.getScriptProperties().getProperty(nombre) || "";
}

function secretoAuth() {
    let valor = propiedad("AUTH_SECRET");
    if (!valor) {
        valor = Utilities.getUuid() + Utilities.getUuid();
        PropertiesService.getScriptProperties().setProperty("AUTH_SECRET", valor);
    }
    return valor;
}

function obtenerHojaUsuarios() {
    const id = propiedad("USUARIOS_SPREADSHEET_ID");
    if (!id) {
        throw new Error("Configura USUARIOS_SPREADSHEET_ID en Propiedades del script.");
    }
    const archivo = SpreadsheetApp.openById(id);
    let hoja = archivo.getSheetByName(AUTH_SHEET_NAME);
    if (!hoja) hoja = archivo.insertSheet(AUTH_SHEET_NAME);

    const ancho = hoja.getLastColumn();
    const cabeceras = ancho ? hoja.getRange(1, 1, 1, ancho).getValues()[0] : [];
    if (cabeceras.join("|") !== AUTH_ENCABEZADOS.join("|")) {
        hoja.getRange(1, 1, 1, Math.max(ancho, AUTH_ENCABEZADOS.length)).clear();
        hoja.getRange(1, 1, 1, AUTH_ENCABEZADOS.length).setValues([AUTH_ENCABEZADOS]);
    }
    return hoja;
}

function leerUsuarios() {
    const hoja = obtenerHojaUsuarios();
    const ultimaFila = hoja.getLastRow();
    if (ultimaFila < 2) return [];
    const valores = hoja.getRange(2, 1, ultimaFila - 1, AUTH_ENCABEZADOS.length).getValues();
    return valores
        .filter(fila => fila[0])
        .map(fila => {
            const u = {};
            AUTH_ENCABEZADOS.forEach((k, i) => { u[k] = fila[i]; });
            return u;
        });
}

function normalizarUsuario(valor) {
    return String(valor || "").trim().toLowerCase();
}

function buscarUsuario(valor) {
    const buscado = normalizarUsuario(valor);
    return leerUsuarios().find(u => normalizarUsuario(u.usuario) === buscado) || null;
}

function usuarioActivo(u) {
    const v = String(u.activo || "").trim().toUpperCase();
    return v === "SI" || v === "SÍ" || v === "TRUE" || v === "1" || v === "ACTIVO";
}

// -----------------------------------------------------------------------------
// Criptografía simple (SHA-256 con salt) y token firmado HMAC
// -----------------------------------------------------------------------------
function bytesHex(bytes) {
    return bytes.map(b => ("0" + ((b & 0xff).toString(16))).slice(-2)).join("");
}

function sha256Hex(texto) {
    return bytesHex(Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, String(texto), Utilities.Charset.UTF_8
    ));
}

function firmaToken(payloadB64) {
    return bytesHex(Utilities.computeHmacSignature(
        Utilities.MacAlgorithm.HMAC_SHA_256, payloadB64, secretoAuth()
    ));
}

function crearToken(u) {
    const payload = {
        usuario: normalizarUsuario(u.usuario),
        nombre: String(u.nombre || ""),
        rol: String(u.rol || ""),
        plantaId: String(u.planta_id || ""),
        correo: String(u.correo || ""),
        exp: Date.now() + (12 * 60 * 60 * 1000),
        nonce: Utilities.getUuid()
    };
    const payloadB64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
    return payloadB64 + "." + firmaToken(payloadB64);
}

function verificarToken(token) {
    try {
        const partes = String(token || "").split(".");
        if (partes.length !== 2) return null;
        if (firmaToken(partes[0]) !== partes[1]) return null;

        const texto = Utilities.newBlob(
            Utilities.base64DecodeWebSafe(partes[0])
        ).getDataAsString();
        const payload = JSON.parse(texto);
        if (!payload.exp || payload.exp < Date.now()) return null;

        const u = buscarUsuario(payload.usuario);
        if (!u || !usuarioActivo(u) || u.rol !== payload.rol) return null;

        return {
            usuario: normalizarUsuario(u.usuario),
            nombre: String(u.nombre || u.usuario),
            correo: String(u.correo || ""),
            rol: String(u.rol),
            plantaId: String(u.planta_id || ""),
            exp: payload.exp,
            token: token
        };
    } catch (err) {
        return null;
    }
}

// -----------------------------------------------------------------------------
// Custom tokens de Firebase (RS256 firmado por la cuenta de servicio).
// La llave privada vive solo en Propiedades del script; nunca viaja al navegador.
// -----------------------------------------------------------------------------
function base64Url(valor) {
    return Utilities.base64EncodeWebSafe(String(valor), Utilities.Charset.UTF_8)
        .replace(/=+$/, "");
}

function firebaseCustomToken(uid, claims) {
    const correo = propiedad("FIREBASE_SERVICE_CLIENT_EMAIL").trim();
    const llave = propiedad("FIREBASE_SERVICE_PRIVATE_KEY").replace(/\\n/g, "\n").trim();
    if (!correo || !llave) return "";

    const ahora = Math.floor(Date.now() / 1000);
    const payload = {
        iss: correo,
        sub: correo,
        aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
        iat: ahora,
        exp: ahora + 3600,
        uid: String(uid || "").slice(0, 128),
        claims: claims || {}
    };
    const sinFirmar = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
        "." + base64Url(JSON.stringify(payload));
    const firma = Utilities.computeRsaSha256Signature(sinFirmar, llave);
    return sinFirmar + "." + Utilities.base64EncodeWebSafe(firma).replace(/=+$/, "");
}

function tokenFirebaseUsuario(u) {
    const usuario = normalizarUsuario(u.usuario);
    const uid = ("u_" + usuario.replace(/[^a-z0-9_-]/g, "_")).slice(0, 128);
    return firebaseCustomToken(uid, {
        rol: String(u.rol || ""),
        planta_id: String(u.planta_id || ""),
        usuario: usuario,
        nombre: String(u.nombre || u.usuario || "")
    });
}

function datosSesionConFirebase(sesion) {
    const copia = Object.assign({}, sesion);
    copia.firebaseToken = tokenFirebaseUsuario(sesion);
    return copia;
}

function sesionDe(u) {
    const token = crearToken(u);
    const sesion = {
        usuario: normalizarUsuario(u.usuario),
        nombre: String(u.nombre || u.usuario),
        correo: String(u.correo || ""),
        rol: String(u.rol),
        plantaId: String(u.planta_id || ""),
        exp: Date.now() + (12 * 60 * 60 * 1000)
    };
    return {
        ok: true,
        token: token,
        sesion: datosSesionConFirebase(sesion)
    };
}

// -----------------------------------------------------------------------------
// Acciones
// -----------------------------------------------------------------------------
function authLogin(datos) {
    const u = buscarUsuario(datos.usuario);
    if (!u) return { ok: false, mensaje: "Usuario no encontrado." };
    if (!usuarioActivo(u)) return { ok: false, mensaje: "El usuario está inactivo." };

    const hash = sha256Hex(String(u.salt || "") + "|" + String(datos.clave || ""));
    if (hash !== String(u.clave_hash || "")) {
        return { ok: false, mensaje: "Clave incorrecta." };
    }
    return sesionDe(u);
}

function authValidar(datos) {
    const sesion = verificarToken(datos.token);
    if (!sesion) return { ok: false, mensaje: "Sesión vencida o inválida." };
    return { ok: true, sesion: datosSesionConFirebase(sesion) };
}

function esAdmin(datos) {
    const sesion = verificarToken(datos.tokenAdmin);
    return !!sesion && sesion.rol === "ADMIN";
}

function authCrear(datos) {
    const usuarios = leerUsuarios();
    const setupKey = String(datos.setupKey || "");
    const esperada = propiedad("USER_SETUP_KEY");

    // El primer usuario se crea con la clave de configuración. Después, solo ADMIN.
    if (usuarios.length === 0) {
        if (!esperada || setupKey !== esperada) {
            return { ok: false, mensaje: "Para crear el primer usuario necesitas la clave de configuración (USER_SETUP_KEY)." };
        }
    } else if (!esAdmin(datos)) {
        return { ok: false, mensaje: "Solo un administrador puede crear usuarios." };
    }

    const usuario = normalizarUsuario(datos.usuario);
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
        return { ok: false, mensaje: "El usuario debe tener entre 3 y 30 caracteres (letras, números, punto, guion o guion bajo)." };
    }
    if (usuarios.some(u => normalizarUsuario(u.usuario) === usuario)) {
        return { ok: false, mensaje: "Ese usuario ya existe." };
    }
    const clave = String(datos.clave || "");
    if (clave.length < 6) {
        return { ok: false, mensaje: "La clave debe tener al menos 6 caracteres." };
    }
    const rol = String(datos.rol || "").toUpperCase();
    if (AUTH_ROLES.indexOf(rol) < 0) {
        return { ok: false, mensaje: "Rol no válido." };
    }
    if (rol === "PLANTA" && !String(datos.plantaId || "")) {
        return { ok: false, mensaje: "Un usuario de planta debe tener una planta asignada." };
    }

    const salt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    const hash = sha256Hex(salt + "|" + clave);
    const hoja = obtenerHojaUsuarios();
    const creadoPor = esAdmin(datos)
        ? verificarToken(datos.tokenAdmin).usuario
        : "setup";
    hoja.appendRow([
        usuario,
        String(datos.nombre || usuario).trim(),
        String(datos.correo || "").trim(),
        rol,
        String(datos.plantaId || "").trim(),
        "SÍ",
        salt,
        hash,
        new Date().toISOString(),
        creadoPor
    ]);

    return { ok: true, mensaje: "Usuario creado. Ya puede iniciar sesión." };
}

function authListar(datos) {
    if (!esAdmin(datos)) return { ok: false, mensaje: "Solo un administrador puede listar usuarios." };
    const usuarios = leerUsuarios().map(u => ({
        usuario: normalizarUsuario(u.usuario),
        nombre: String(u.nombre || ""),
        correo: String(u.correo || ""),
        rol: String(u.rol || ""),
        plantaId: String(u.planta_id || ""),
        activo: usuarioActivo(u)
    }));
    return { ok: true, usuarios: usuarios };
}

function authCambiarClave(datos) {
    const usuario = normalizarUsuario(datos.usuario);
    const sesion = verificarToken(datos.tokenAdmin);
    if (!sesion || (sesion.rol !== "ADMIN" && sesion.usuario !== usuario)) {
        return { ok: false, mensaje: "No tienes permiso para cambiar esta clave." };
    }
    const u = buscarUsuario(usuario);
    if (!u) return { ok: false, mensaje: "Usuario no encontrado." };
    const clave = String(datos.claveNueva || "");
    if (clave.length < 6) return { ok: false, mensaje: "La clave debe tener al menos 6 caracteres." };

    const hoja = obtenerHojaUsuarios();
    const filas = hoja.getRange(2, 1, hoja.getLastRow() - 1, AUTH_ENCABEZADOS.length).getValues();
    const salt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    const hash = sha256Hex(salt + "|" + clave);
    for (let i = 0; i < filas.length; i++) {
        if (normalizarUsuario(filas[i][0]) === usuario) {
            hoja.getRange(i + 2, AUTH_ENCABEZADOS.indexOf("salt") + 1).setValue(salt);
            hoja.getRange(i + 2, AUTH_ENCABEZADOS.indexOf("clave_hash") + 1).setValue(hash);
            return { ok: true, mensaje: "Clave actualizada." };
        }
    }
    return { ok: false, mensaje: "Usuario no encontrado." };
}

// -----------------------------------------------------------------------------
// Registro de enlaces públicos de firma. Permite que firmar.html obtenga un
// custom token de Firebase sin conocer usuario ni clave.
// -----------------------------------------------------------------------------
function obtenerHojaFirmas() {
    const id = propiedad("USUARIOS_SPREADSHEET_ID");
    if (!id) {
        throw new Error("Configura USUARIOS_SPREADSHEET_ID en Propiedades del script.");
    }
    const archivo = SpreadsheetApp.openById(id);
    let hoja = archivo.getSheetByName(FIRMAS_SHEET_NAME);
    if (!hoja) hoja = archivo.insertSheet(FIRMAS_SHEET_NAME);

    const ancho = hoja.getLastColumn();
    const cabeceras = ancho ? hoja.getRange(1, 1, 1, ancho).getValues()[0] : [];
    if (cabeceras.join("|") !== FIRMAS_ENCABEZADOS.join("|")) {
        hoja.getRange(1, 1, 1, Math.max(ancho, FIRMAS_ENCABEZADOS.length)).clear();
        hoja.getRange(1, 1, 1, FIRMAS_ENCABEZADOS.length).setValues([FIRMAS_ENCABEZADOS]);
    }
    return hoja;
}

function tipoFirma(valor) {
    return String(valor) === "despacho" ? "despacho" : "ficha";
}

function authRegistrarFirma(datos) {
    const sesion = verificarToken(datos.tokenSesion);
    if (!sesion || sesion.rol === "LECTURA") {
        return { ok: false, mensaje: "Solo un usuario autorizado puede registrar enlaces de firma." };
    }
    const id = String(datos.id || "").trim();
    const token = String(datos.token || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !token) {
        return { ok: false, mensaje: "Datos de firma no válidos." };
    }
    const tipo = tipoFirma(datos.tipo);
    let registroJson = "";
    try {
        registroJson = JSON.stringify(datos.registro || {});
    } catch (err) {
        registroJson = "{}";
    }
    if (registroJson.length > 45000) registroJson = "{}";

    const hoja = obtenerHojaFirmas();
    const ultimaFila = hoja.getLastRow();
    if (ultimaFila > 1) {
        const filas = hoja.getRange(2, 1, ultimaFila - 1, FIRMAS_ENCABEZADOS.length).getValues();
        for (let i = 0; i < filas.length; i++) {
            if (String(filas[i][0]) === id && String(filas[i][2]) === tipo) {
                hoja.getRange(i + 2, 1, 1, FIRMAS_ENCABEZADOS.length).setValues([[
                    id, token, tipo, String(datos.plantaId || ""), registroJson, new Date().toISOString()
                ]]);
                return { ok: true, mensaje: "Enlace de firma actualizado." };
            }
        }
    }
    hoja.appendRow([
        id, token, tipo, String(datos.plantaId || ""), registroJson, new Date().toISOString()
    ]);
    return { ok: true, mensaje: "Enlace de firma registrado." };
}

function buscarFirmaPublica(id, token, tipo) {
    const hoja = obtenerHojaFirmas();
    const ultimaFila = hoja.getLastRow();
    if (ultimaFila < 2) return null;
    const filas = hoja.getRange(2, 1, ultimaFila - 1, FIRMAS_ENCABEZADOS.length).getValues();
    const fila = filas.find(f => String(f[0]) === id && String(f[1]) === token && String(f[2]) === tipo);
    if (!fila) return null;
    let registro = {};
    try {
        registro = JSON.parse(String(fila[4] || "{}"));
    } catch (err) {
        registro = {};
    }
    return registro;
}

function authTokenFirmaPublica(datos) {
    const id = String(datos.id || "").trim();
    const token = String(datos.token || "").trim();
    const tipo = tipoFirma(datos.tipo);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !token) {
        return { ok: false, mensaje: "El enlace de firma no es válido." };
    }
    const registro = buscarFirmaPublica(id, token, tipo);
    if (!registro || !registro.id) {
        return { ok: false, mensaje: "El enlace de firma no está registrado o fue reemplazado." };
    }
    const uid = ("firma_" + id.replace(/[^A-Za-z0-9_-]/g, "_")).slice(0, 128);
    const firebaseToken = firebaseCustomToken(uid, {
        firma: true,
        ficha_id: id,
        tipo: tipo
    });
    if (!firebaseToken) {
        return { ok: false, mensaje: "Falta configurar la cuenta de servicio de Firebase en el Apps Script." };
    }
    return { ok: true, firebaseToken: firebaseToken, registro: registro };
}

// -----------------------------------------------------------------------------
// Utilidad para ejecutar una vez desde el editor de Apps Script:
// crea la hoja "Usuarios" y deja lista la configuración.
// -----------------------------------------------------------------------------
function inicializarAuth() {
    const hoja = obtenerHojaUsuarios();
    obtenerHojaFirmas();
    secretoAuth();
    if (!propiedad("USER_SETUP_KEY")) {
        PropertiesService.getScriptProperties().setProperty(
            "USER_SETUP_KEY", "Crearte-Alta-" + Utilities.getUuid().slice(0, 8)
        );
    }
    const url = hoja.getParent().getUrl();
    Logger.log("Hoja: " + url);
    Logger.log("USER_SETUP_KEY: " + propiedad("USER_SETUP_KEY"));
    Logger.log("Firebase service account configurado: " +
        (propiedad("FIREBASE_SERVICE_CLIENT_EMAIL") && propiedad("FIREBASE_SERVICE_PRIVATE_KEY") ? "SÍ" : "NO"));
    return url;
}
