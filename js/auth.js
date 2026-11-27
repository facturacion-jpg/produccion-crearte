// js/auth.js
// Login y roles usando Google Sheets a través de un Web App de Apps Script.
// La clave nunca se guarda en la hoja: se envía salt + SHA-256.

(function () {
    "use strict";

    const SESION_KEY = "crearte_auth_sesion";

    // Permisos que entiende js/app.js.
    const ROLES = {
        ADMIN: {
            etiqueta: "Administrador",
            vistas: ["central", "planta"],
            permisos: ["fichas", "avance", "solicitar", "despachar", "configurar", "exportar", "usuarios"]
        },
        FICHAS: {
            etiqueta: "Fichas y salidas",
            vistas: ["central"],
            permisos: ["fichas", "avance", "solicitar", "exportar"]
        },
        TELAS: {
            etiqueta: "Bodega de Telas",
            vistas: ["central"],
            permisos: ["despachar", "exportar"]
        },
        INSUMOS: {
            etiqueta: "Almacén de Insumos",
            vistas: ["central"],
            permisos: ["despachar", "exportar"]
        },
        PLANTA: {
            etiqueta: "Planta externa",
            vistas: ["planta"],
            permisos: ["avance", "solicitar", "exportar"]
        },
        LECTURA: {
            etiqueta: "Solo consulta",
            vistas: ["central", "planta"],
            permisos: ["exportar"]
        }
    };

    let sesion = null;

    function habilitado() {
        return !!(typeof APP_SYSTEM !== "undefined" && APP_SYSTEM.apiAuthUrl);
    }

    function normalizarSesion(valor) {
        if (!valor) return null;
        const rol = String(valor.rol || "LECTURA").toUpperCase();
        return {
            usuario: String(valor.usuario || ""),
            nombre: String(valor.nombre || valor.usuario || "Usuario"),
            correo: String(valor.correo || ""),
            rol: ROLES[rol] ? rol : "LECTURA",
            plantaId: String(valor.plantaId || valor.planta_id || ""),
            exp: Number(valor.exp || 0),
            token: String(valor.token || "")
        };
    }

    function leerSesion() {
        try {
            const texto = sessionStorage.getItem(SESION_KEY);
            if (!texto) return null;
            const guardada = normalizarSesion(JSON.parse(texto));
            if (!guardada || !guardada.token) return null;
            if (guardada.exp && guardada.exp < Date.now()) {
                sessionStorage.removeItem(SESION_KEY);
                return null;
            }
            return guardada;
        } catch (err) {
            return null;
        }
    }

    function guardarSesion(valor) {
        sesion = normalizarSesion(valor);
        try {
            sessionStorage.setItem(SESION_KEY, JSON.stringify(sesion));
        } catch (err) {
            // Si sessionStorage está bloqueado, la sesión vive solo en memoria.
        }
        return sesion;
    }

    function limpiarSesion() {
        sesion = null;
        try {
            sessionStorage.removeItem(SESION_KEY);
        } catch (err) {
            // No hay nada que limpiar.
        }
    }

    function definicionRol(rol) {
        const normalizado = String(rol || sesion?.rol || "").toUpperCase();
        const definicion = ROLES[normalizado] || ROLES.LECTURA;
        return Object.assign({ rol: ROLES[normalizado] ? normalizado : "LECTURA" }, definicion);
    }

    function tiene(permiso) {
        if (!habilitado()) return true;
        return definicionRol().permisos.indexOf(permiso) >= 0;
    }

    function vistasPermitidas() {
        if (!habilitado()) return ["central", "planta"];
        return definicionRol().vistas.slice();
    }

    function puedeDespacharArea(area) {
        if (!habilitado()) return true;
        const rol = definicionRol().rol || sesion?.rol;
        if (rol === "ADMIN") return true;
        if (rol === "TELAS") return area === "TELA";
        if (rol === "INSUMOS") return area === "INSUMO";
        return false;
    }

    function obtenerSesion() {
        return sesion;
    }

    function textoEstado(id, mensaje, esError) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = mensaje || "";
        el.classList.toggle("hidden", !mensaje);
        el.classList.toggle("bg-rose-50", !!esError);
        el.classList.toggle("border", !!esError);
        el.classList.toggle("border-rose-200", !!esError);
        el.classList.toggle("text-rose-700", !!esError);
    }

    function mostrarOverlay(mensaje) {
        const overlay = document.getElementById("login-overlay");
        if (!overlay) return;
        overlay.classList.remove("hidden");
        overlay.classList.add("flex");
        actualizarVistaAuth("login");
        if (mensaje) textoEstado("login-estado", mensaje, false);
        if (window.lucide && typeof window.lucide.createIcons === "function") {
            window.lucide.createIcons();
        }
    }

    function ocultarOverlay() {
        const overlay = document.getElementById("login-overlay");
        if (!overlay) return;
        overlay.classList.add("hidden");
        overlay.classList.remove("flex");
    }

    function nuevoNonce() {
        if (window.crypto && typeof window.crypto.getRandomValues === "function") {
            const bytes = new Uint32Array(2);
            window.crypto.getRandomValues(bytes);
            return "auth_" + bytes[0].toString(36) + bytes[1].toString(36) + "_" + Date.now().toString(36);
        }
        return "auth_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36);
    }

    // Apps Script no devuelve cabeceras CORS y usa X-Frame-Options, así que un
    // iframe oculto no sirve. El payload va por POST opaco y el resultado se lee
    // con JSONP (<script src>), usando un nonce como clave de correlación.
    function llamar(accion, datos) {
        return new Promise(resolve => {
            if (!habilitado()) {
                resolve({ ok: false, mensaje: "La URL del Web App de autenticación no está configurada." });
                return;
            }

            const nonce = nuevoNonce();
            const cb = "crearteAuthCb_" + nonce.replace(/[^A-Za-z0-9_$]/g, "_");
            const timeoutMs = 25000;
            const mensajeError = "No se pudo contactar con el servidor de usuarios. Revisa la URL del Web App y vuelve a intentar.";
            let terminado = false;
            let script = null;
            let timer = null;
            let pollTimer = null;

            function limpiar() {
                if (timer) window.clearTimeout(timer);
                if (pollTimer) window.clearTimeout(pollTimer);
                if (script && script.parentNode) script.parentNode.removeChild(script);
                try { delete window[cb]; } catch (err) { window[cb] = undefined; }
            }

            function finalizar(resultado) {
                if (terminado) return;
                terminado = true;
                limpiar();
                resolve(resultado);
            }

            function consultar() {
                if (terminado) return;
                if (script && script.parentNode) script.parentNode.removeChild(script);
                script = document.createElement("script");
                script.async = true;
                script.src = APP_SYSTEM.apiAuthUrl +
                    (APP_SYSTEM.apiAuthUrl.indexOf("?") >= 0 ? "&" : "?") +
                    "accion=resultado&nonce=" + encodeURIComponent(nonce) +
                    "&cb=" + encodeURIComponent(cb) + "&_=" + Date.now();
                script.onerror = function () {
                    finalizar({ ok: false, mensaje: mensajeError });
                };
                document.head.appendChild(script);
            }

            window[cb] = function (respuesta) {
                if (!respuesta || respuesta.nonce !== nonce) return;
                if (respuesta.pendiente) {
                    pollTimer = window.setTimeout(consultar, 400);
                    return;
                }
                finalizar(respuesta.resultado || { ok: false, mensaje: mensajeError });
            };

            timer = window.setTimeout(() => {
                finalizar({ ok: false, mensaje: mensajeError });
            }, timeoutMs);

            // POST "no-cors": la respuesta es opaca, pero el Web App procesa la
            // acción y guarda el resultado. Después se lee con JSONP por nonce.
            try {
                const cuerpo = new URLSearchParams();
                cuerpo.append("payload", JSON.stringify({ accion: accion, datos: datos || {}, nonce: nonce }));
                const enviado = typeof navigator.sendBeacon === "function" &&
                    navigator.sendBeacon(APP_SYSTEM.apiAuthUrl, cuerpo);
                if (!enviado) {
                    fetch(APP_SYSTEM.apiAuthUrl, {
                        method: "POST",
                        mode: "no-cors",
                        credentials: "omit",
                        body: cuerpo
                    }).catch(function () { /* la respuesta es opaca; se consulta por JSONP */ });
                }
            } catch (err) {
                finalizar({ ok: false, mensaje: mensajeError });
                return;
            }

            pollTimer = window.setTimeout(consultar, 700);
        });
    }

    async function iniciar() {
        if (!habilitado()) {
            limpiarSesion();
            ocultarOverlay();
            return null;
        }

        const guardada = leerSesion();
        if (guardada) {
            mostrarOverlay("Validando sesión…");
            const respuesta = await llamar("validar", { token: guardada.token });
            if (respuesta.ok && respuesta.sesion) {
                guardarSesion(Object.assign({}, respuesta.sesion, { token: guardada.token }));
                ocultarOverlay();
                return sesion;
            }
            limpiarSesion();
        }

        mostrarOverlay();
        textoEstado("login-estado", "Ingresa con el usuario y la clave registrados en Google Sheets.", false);
        return null;
    }

    async function login(evento) {
        if (evento) evento.preventDefault();
        const usuario = (document.getElementById("login-usuario")?.value || "").trim();
        const clave = document.getElementById("login-clave")?.value || "";
        textoEstado("login-error", "", false);

        if (!usuario || !clave) {
            textoEstado("login-error", "Escribe el usuario y la clave.", true);
            return;
        }

        const btn = document.getElementById("login-submit");
        if (btn) btn.disabled = true;
        textoEstado("login-estado", "Verificando…", false);

        const respuesta = await llamar("login", { usuario: usuario, clave: clave });
        if (btn) btn.disabled = false;

        if (!respuesta.ok) {
            textoEstado("login-error", respuesta.mensaje || "No se pudo iniciar sesión.", true);
            textoEstado("login-estado", "", false);
            return;
        }

        guardarSesion(Object.assign({}, respuesta.sesion || {}, {
            token: respuesta.token || (respuesta.sesion && respuesta.sesion.token) || ""
        }));
        window.location.reload();
    }

    function htmlSeguro(valor) {
        return String(valor || "").replace(/[&<>"']/g, car => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[car]);
    }

    function actualizarVistaAuth(vista) {
        const esCrear = vista === "crear";
        const loginForm = document.getElementById("login-form");
        const crearForm = document.getElementById("crear-usuario-form");
        const tabLogin = document.getElementById("auth-tab-login");
        const tabCrear = document.getElementById("auth-tab-crear");

        if (loginForm) loginForm.classList.toggle("hidden", esCrear);
        if (crearForm) crearForm.classList.toggle("hidden", !esCrear);

        if (tabLogin) {
            tabLogin.classList.toggle("is-active", !esCrear);
            tabLogin.setAttribute("aria-selected", String(!esCrear));
        }
        if (tabCrear) {
            tabCrear.classList.toggle("is-active", esCrear);
            tabCrear.setAttribute("aria-selected", String(esCrear));
        }
    }

    function plantasDisponibles() {
        const origen = document.getElementById("active-planta-selector");
        if (origen && origen.options && origen.options.length) {
            return Array.from(origen.options)
                .filter(op => op.value)
                .map(op => ({ id: op.value, texto: op.textContent }));
        }
        if (typeof appPlantas !== "undefined" && Array.isArray(appPlantas)) {
            return appPlantas.map(p => ({
                id: p.id,
                texto: p.nombre + (p.ciudad ? " (" + String(p.ciudad).split("-")[0].trim() + ")" : "")
            }));
        }
        return [];
    }

    function conectarFormularioCrear() {
        const rol = document.getElementById("new-rol");
        const planta = document.getElementById("new-planta");
        if (rol && !rol.dataset.authReady) {
            rol.addEventListener("change", actualizarCamposRol);
            rol.dataset.authReady = "1";
        }
        if (planta && !planta.dataset.authReady) {
            planta.addEventListener("change", actualizarCamposRol);
            planta.dataset.authReady = "1";
        }
    }

    function actualizarCamposRol() {
        const rol = (document.getElementById("new-rol")?.value || "LECTURA").toUpperCase();
        const campoPlanta = document.getElementById("new-planta-field");
        const planta = document.getElementById("new-planta");
        const ayudaRol = document.getElementById("new-rol-help");
        const ayudaPlanta = document.getElementById("new-planta-help");

        const guia = {
            ADMIN: "Puede crear usuarios, cambiar configuración y ver todas las áreas y plantas.",
            FICHAS: "Puede registrar fichas técnicas y salidas, y exportarlas. No crea usuarios ni cambia configuración.",
            TELAS: "Puede despachar materiales de la bodega de telas y exportar. No ve la configuración.",
            INSUMOS: "Puede despachar materiales del almacén de insumos y exportar. No ve la configuración.",
            PLANTA: "Ve solo la planta asignada, puede solicitar materiales y confirmar recepciones.",
            LECTURA: "Solo puede consultar y exportar información. No puede editar ni despachar."
        };
        if (ayudaRol) ayudaRol.textContent = guia[rol] || guia.LECTURA;

        const esPlanta = rol === "PLANTA";
        if (campoPlanta) campoPlanta.classList.toggle("hidden", !esPlanta);
        if (planta) {
            planta.disabled = !esPlanta;
            planta.required = esPlanta;
            if (!esPlanta) planta.value = "";
        }

        if (ayudaPlanta) {
            if (!esPlanta) {
                ayudaPlanta.textContent = "La planta solo se elige cuando el rol es Planta externa.";
                return;
            }
            const elegida = typeof appPlantas !== "undefined" && Array.isArray(appPlantas)
                ? appPlantas.find(p => p.id === (planta?.value || ""))
                : null;
            ayudaPlanta.textContent = elegida
                ? "Este usuario verá solo " + elegida.nombre + (elegida.ciudad ? " — " + elegida.ciudad : "") + "."
                : "Selecciona la planta a la que pertenece. El usuario verá solo esa planta.";
        }
    }

    function cargarPlantasEnFormulario() {
        const destino = document.getElementById("new-planta");
        if (!destino) return;
        const actual = destino.value;
        destino.innerHTML = '<option value="">Selecciona la planta</option>' +
            plantasDisponibles()
                .map(op => `<option value="${htmlSeguro(op.id)}">${htmlSeguro(op.texto)}</option>`)
                .join("");
        destino.value = actual;
        actualizarCamposRol();
    }

    function mostrarLogin() {
        actualizarVistaAuth("login");
        mostrarOverlay();
    }

    function mostrarCrearUsuario() {
        mostrarOverlay();
        actualizarVistaAuth("crear");
        textoEstado("crear-error", "", false);
        conectarFormularioCrear();
        cargarPlantasEnFormulario();

        const cajaSetup = document.getElementById("new-setup-box");
        const esAdmin = sesion && sesion.rol === "ADMIN";
        if (cajaSetup) cajaSetup.classList.toggle("hidden", !!esAdmin);
    }

    function ocultarCrearUsuario() {
        textoEstado("crear-error", "", false);
        actualizarVistaAuth("login");
        if (sesion && sesion.rol === "ADMIN") {
            ocultarOverlay();
            return;
        }
        mostrarOverlay();
    }

    async function crearUsuario(evento) {
        if (evento) evento.preventDefault();
        textoEstado("crear-error", "", false);

        const rol = (document.getElementById("new-rol")?.value || "LECTURA").toUpperCase();
        const planta = document.getElementById("new-planta");
        const plantaId = rol === "PLANTA" && planta && !planta.disabled
            ? (planta.value || "").trim()
            : "";
        const datos = {
            usuario: (document.getElementById("new-usuario")?.value || "").trim(),
            nombre: (document.getElementById("new-nombre")?.value || "").trim(),
            correo: (document.getElementById("new-correo")?.value || "").trim(),
            rol: rol,
            plantaId: plantaId,
            clave: document.getElementById("new-clave")?.value || "",
            setupKey: document.getElementById("new-setup-key")?.value || "",
            tokenAdmin: sesion?.token || ""
        };

        if (rol === "PLANTA" && !plantaId) {
            textoEstado("crear-error", "Selecciona la planta asignada para este usuario.", true);
            return;
        }

        const btn = document.getElementById("crear-submit");
        if (btn) btn.disabled = true;

        const respuesta = await llamar("crear", datos);
        if (btn) btn.disabled = false;

        if (!respuesta.ok) {
            textoEstado("crear-error", respuesta.mensaje || "No se pudo crear el usuario.", true);
            return;
        }

        const mensaje = respuesta.mensaje || "Usuario creado. Ya puede iniciar sesión.";
        const form = document.getElementById("crear-usuario-form");
        if (form) form.reset();
        actualizarCamposRol();

        if (sesion && sesion.rol === "ADMIN") {
            textoEstado("login-estado", mensaje, false);
            ocultarCrearUsuario();
            if (typeof showToast === "function") showToast(mensaje);
            return;
        }

        ocultarCrearUsuario();
        textoEstado("login-estado", mensaje, false);
        const usuarioInput = document.getElementById("login-usuario");
        if (usuarioInput) usuarioInput.value = datos.usuario;
        const claveInput = document.getElementById("login-clave");
        if (claveInput) claveInput.value = "";
        if (usuarioInput) usuarioInput.focus();
    }

    function logout() {
        limpiarSesion();
        window.location.reload();
    }

    window.Auth = {
        habilitado: habilitado,
        iniciar: iniciar,
        login: login,
        crearUsuario: crearUsuario,
        mostrarLogin: mostrarLogin,
        mostrarCrearUsuario: mostrarCrearUsuario,
        ocultarCrearUsuario: ocultarCrearUsuario,
        logout: logout,
        sesion: obtenerSesion,
        tiene: tiene,
        vistasPermitidas: vistasPermitidas,
        puedeDespacharArea: puedeDespacharArea,
        etiquetaRol: function (rol) { return definicionRol(rol).etiqueta; },
        roles: ROLES
    };
})();
