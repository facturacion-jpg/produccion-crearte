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
            let form = null;
            let iframe = null;
            let timer = null;
            let pollTimer = null;

            function limpiar() {
                if (timer) window.clearTimeout(timer);
                if (pollTimer) window.clearTimeout(pollTimer);
                if (script && script.parentNode) script.parentNode.removeChild(script);
                if (form && form.parentNode) form.parentNode.removeChild(form);
                if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
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

            // El iframe no puede mostrar la respuesta (X-Frame-Options), pero el
            // POST llega igual al Web App. El resultado se obtiene por JSONP.
            try {
                iframe = document.createElement("iframe");
                iframe.name = "auth-post-" + nonce;
                iframe.style.display = "none";
                iframe.setAttribute("aria-hidden", "true");

                form = document.createElement("form");
                form.method = "POST";
                form.action = APP_SYSTEM.apiAuthUrl;
                form.target = iframe.name;
                form.style.display = "none";

                const input = document.createElement("input");
                input.type = "hidden";
                input.name = "payload";
                input.value = JSON.stringify({ accion: accion, datos: datos || {}, nonce: nonce });
                form.appendChild(input);

                document.body.appendChild(iframe);
                document.body.appendChild(form);
                form.submit();
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

    function cargarPlantasEnFormulario() {
        const destino = document.getElementById("new-planta");
        const origen = document.getElementById("active-planta-selector");
        if (!destino || !origen) return;
        const actual = destino.value;
        destino.innerHTML = '<option value="">Planta (solo para rol PLANTA)</option>' +
            Array.from(origen.options || [])
                .filter(op => op.value)
                .map(op => `<option value="${op.value}">${op.textContent}</option>`)
                .join("");
        destino.value = actual;
    }

    function mostrarCrearUsuario() {
        const form = document.getElementById("crear-usuario-form");
        const loginForm = document.getElementById("login-form");
        if (!form) return;
        form.classList.remove("hidden");
        if (loginForm) loginForm.classList.add("hidden");
        textoEstado("crear-error", "", false);
        cargarPlantasEnFormulario();

        const cajaSetup = document.getElementById("new-setup-box");
        const esAdmin = sesion && sesion.rol === "ADMIN";
        if (cajaSetup) cajaSetup.classList.toggle("hidden", !!esAdmin);
    }

    function ocultarCrearUsuario() {
        const form = document.getElementById("crear-usuario-form");
        const loginForm = document.getElementById("login-form");
        if (form) form.classList.add("hidden");
        if (loginForm) loginForm.classList.remove("hidden");
        textoEstado("crear-error", "", false);
    }

    async function crearUsuario(evento) {
        if (evento) evento.preventDefault();
        textoEstado("crear-error", "", false);

        const datos = {
            usuario: (document.getElementById("new-usuario")?.value || "").trim(),
            nombre: (document.getElementById("new-nombre")?.value || "").trim(),
            correo: (document.getElementById("new-correo")?.value || "").trim(),
            rol: (document.getElementById("new-rol")?.value || "LECTURA").toUpperCase(),
            plantaId: (document.getElementById("new-planta")?.value || "").trim(),
            clave: document.getElementById("new-clave")?.value || "",
            setupKey: document.getElementById("new-setup-key")?.value || "",
            tokenAdmin: sesion?.token || ""
        };

        const btn = document.getElementById("crear-submit");
        if (btn) btn.disabled = true;

        const respuesta = await llamar("crear", datos);
        if (btn) btn.disabled = false;

        if (!respuesta.ok) {
            textoEstado("crear-error", respuesta.mensaje || "No se pudo crear el usuario.", true);
            return;
        }

        const form = document.getElementById("crear-usuario-form");
        if (form) form.reset();
        ocultarCrearUsuario();
        textoEstado("login-estado", respuesta.mensaje || "Usuario creado. Ya puede iniciar sesión.", false);
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
