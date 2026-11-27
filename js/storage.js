// js/storage.js
// Capa de datos con Firebase Realtime Database - Producción | Crearte By Confeccionarte SAS

let dbRealtime = null;
// Las lecturas/escrituras esperan a que exista una sesión anónima cuando las
// reglas de la base de datos exigen autenticación. Si el proveedor no está
// habilitado en la consola, se continúa igual y Firebase rechazará la operación.
let dbAuthReady = Promise.resolve(false);
try {
    if (window.firebase && typeof FIREBASE_CONFIG !== "undefined") {
        if (!firebase.apps.length) {
            firebase.initializeApp(FIREBASE_CONFIG);
        }
        if (firebase.auth) {
            dbAuthReady = new Promise(resolve => {
                firebase.auth().onAuthStateChanged(user => {
                    if (user) {
                        resolve(true);
                        return;
                    }
                    firebase.auth().signInAnonymously()
                        .then(() => resolve(true))
                        .catch(err => {
                            console.warn("Autenticación anónima no disponible:", err.code || err);
                            resolve(false);
                        });
                });
            });
        }
        dbRealtime = firebase.database();
    }
} catch (err) {
    console.warn("Firebase operando en modo respaldo local:", err);
}

const SafeStorage = (() => {
    const memoria = {};
    return {
        getItem(clave) {
            try { return window.localStorage.getItem(clave); }
            catch (e) { return Object.prototype.hasOwnProperty.call(memoria, clave) ? memoria[clave] : null; }
        },
        setItem(clave, valor) {
            memoria[clave] = String(valor);
            try { window.localStorage.setItem(clave, valor); } catch (e) {}
        },
        removeItem(clave) {
            delete memoria[clave];
            try { window.localStorage.removeItem(clave); } catch (e) {}
        }
    };
})();

const DEFAULT_FICHAS = [];
const DEFAULT_SOLICITUDES = [];

const DataStore = {
    KEYS: {
        CONFIG: "produccion_config",
        PLANTAS: "produccion_plantas",
        FICHAS: "produccion_fichas",
        SOLICITUDES: "produccion_solicitudes",
        FIRMAS: "produccion_firmas",
        FIRMAS_DESPACHOS: "produccion_firmas_despachos"
    },

    load(key, fallback) {
        try {
            const raw = SafeStorage.getItem(key);
            return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(fallback));
        } catch (e) {
            return JSON.parse(JSON.stringify(fallback));
        }
    },

    save(key, data) {
        SafeStorage.setItem(key, JSON.stringify(data));
        let sync = Promise.resolve();
        if (dbRealtime) {
            sync = dbAuthReady
                .then(() => dbRealtime.ref("crearte_produccion/" + key).set(data))
                .catch(e => console.error("Error guardando en Realtime DB:", e));
        }
        this.notificarPanelCentral(key, data);
        return sync;
    },

    suscribirTiempoReal(onUpdateCallback) {
        if (!dbRealtime) return;
        dbAuthReady.then(() => {
            dbRealtime.ref("crearte_produccion").on("value", snapshot => {
                const val = snapshot.val();
                if (val) {
                    Object.keys(this.KEYS).forEach(k => {
                        const keyName = this.KEYS[k];
                        if (val[keyName] !== undefined) {
                            SafeStorage.setItem(keyName, JSON.stringify(val[keyName]));
                        } else if (keyName === this.KEYS.FIRMAS || keyName === this.KEYS.FIRMAS_DESPACHOS) {
                            // Si se elimina la última firma, Firebase deja de enviar el nodo.
                            // Hay que limpiar la copia local para no mostrar evidencia vieja.
                            SafeStorage.removeItem(keyName);
                        }
                    });
                    if (typeof onUpdateCallback === "function") {
                        onUpdateCallback();
                    }
                }
            });
        }).catch(e => console.error("Error suscribiendo a Realtime DB:", e));
    },

    notificarPanelCentral(modulo, payload) {
        if (!APP_SYSTEM.panelCentralUrl) return;
        fetch(APP_SYSTEM.panelCentralUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${APP_SYSTEM.tokenIntegracion}`
            },
            body: JSON.stringify({
                origen: APP_SYSTEM.nombreApp,
                empresa: APP_SYSTEM.empresa,
                evento: modulo,
                timestamp: new Date().toISOString(),
                datos: payload
            })
        }).catch(() => {});
    },

    async enviarCorreoConPdf(datosCorreo) {
        if (!APP_SYSTEM.apiCorreoPdfUrl) return { modo: "local", ok: true };

        const payload = {
            empresa: APP_SYSTEM.empresa,
            token: APP_SYSTEM.tokenIntegracion,
            ...datosCorreo
        };

        try {
            // Un Web App de Google Apps Script no devuelve cabeceras CORS: el navegador
            // envía la petición pero no puede leer la respuesta. Con "no-cors" el envío
            // se realiza una sola vez y no se generan duplicados por reintentos.
            await fetch(APP_SYSTEM.apiCorreoPdfUrl, {
                method: "POST",
                mode: "no-cors",
                body: JSON.stringify(payload)
            });
            return { ok: true, modo: "apps-script-no-cors" };
        } catch (err) {
            console.error("Error de red enviando correo:", err);
            return { ok: false, error: String(err && err.message ? err.message : err) };
        }
    },

    resetAll() {
        Object.values(this.KEYS).forEach(k => SafeStorage.removeItem(k));
    }
};