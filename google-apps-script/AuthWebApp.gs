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
//
// La hoja se llama "Usuarios" y se crea sola con estas columnas:
//   usuario | nombre | correo | rol | planta_id | activo | salt | clave_hash | creado_at | creado_por
//
// Roles válidos: ADMIN, FICHAS, TELAS, INSUMOS, PLANTA, LECTURA.
// Nunca guardes la clave en texto plano: se almacena salt + SHA-256.
// =============================================================================

const AUTH_SHEET_NAME = "Usuarios";
const AUTH_ENCABEZADOS = [
    "usuario", "nombre", "correo", "rol", "planta_id", "activo",
    "salt", "clave_hash", "creado_at", "creado_por"
];
const AUTH_ROLES = ["ADMIN", "FICHAS", "TELAS", "INSUMOS", "PLANTA", "LECTURA"];

function doGet() {
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
    return responderAlPadre(resultado, String((data && data.nonce) || ""));
}

// -----------------------------------------------------------------------------
// Respuesta sin CORS: el navegador abre el formulario en un iframe oculto y
// esta página le devuelve el resultado con postMessage.
// -----------------------------------------------------------------------------
function responderAlPadre(resultado, nonce) {
    const json = JSON.stringify(resultado)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e");
    const html = "<!doctype html><html><head><meta charset='utf-8'></head><body>" +
        "<script>window.parent.postMessage({ nonce: " + JSON.stringify(nonce) +
        ", resultado: " + json + " }, '*');<\/script></body></html>";
    return HtmlService.createHtmlOutput(html);
}

function manejarAuth(data) {
    const accion = String(data.accion || "");
    const datos = data.datos || {};

    if (accion === "login") return authLogin(datos);
    if (accion === "validar") return authValidar(datos);
    if (accion === "crear") return authCrear(datos);
    if (accion === "listar") return authListar(datos);
    if (accion === "cambiarClave") return authCambiarClave(datos);
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

function sesionDe(u) {
    const token = crearToken(u);
    return {
        ok: true,
        token: token,
        sesion: {
            usuario: normalizarUsuario(u.usuario),
            nombre: String(u.nombre || u.usuario),
            correo: String(u.correo || ""),
            rol: String(u.rol),
            plantaId: String(u.planta_id || ""),
            exp: Date.now() + (12 * 60 * 60 * 1000)
        }
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
    return { ok: true, sesion: sesion };
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
// Utilidad para ejecutar una vez desde el editor de Apps Script:
// crea la hoja "Usuarios" y deja lista la configuración.
// -----------------------------------------------------------------------------
function inicializarAuth() {
    const hoja = obtenerHojaUsuarios();
    secretoAuth();
    if (!propiedad("USER_SETUP_KEY")) {
        PropertiesService.getScriptProperties().setProperty(
            "USER_SETUP_KEY", "Crearte-Alta-" + Utilities.getUuid().slice(0, 8)
        );
    }
    const url = hoja.getParent().getUrl();
    Logger.log("Hoja: " + url);
    Logger.log("USER_SETUP_KEY: " + propiedad("USER_SETUP_KEY"));
    return url;
}
