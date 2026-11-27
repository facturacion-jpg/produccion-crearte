// js/app.js
// Lógica principal - Producción | Crearte By Confeccionarte SAS (Identidad Amarillo/Negro)

let appConfig = DataStore.load(DataStore.KEYS.CONFIG, DEFAULT_CONFIG);
if (!appConfig.despachadorNombre) {
    appConfig.despachadorNombre = appConfig.telaNombre || DEFAULT_CONFIG.despachadorNombre;
}
if (!appConfig.contabilidadEmail) appConfig.contabilidadEmail = DEFAULT_CONFIG.contabilidadEmail;
if (!appConfig.contabilidadNombre) appConfig.contabilidadNombre = DEFAULT_CONFIG.contabilidadNombre;
if (!appConfig.publicBaseUrl) appConfig.publicBaseUrl = DEFAULT_CONFIG.publicBaseUrl;
let appPlantas = DataStore.load(DataStore.KEYS.PLANTAS, DEFAULT_PLANTAS);
let appFichas = DataStore.load(DataStore.KEYS.FICHAS, []);
let appSolicitudes = DataStore.load(DataStore.KEYS.SOLICITUDES, []);
let appFirmas = DataStore.load(DataStore.KEYS.FIRMAS, {});
let appFirmasDespachos = DataStore.load(DataStore.KEYS.FIRMAS_DESPACHOS, {});

let currentRole = "central";
let activePlantaId = appPlantas[0]?.id || "PLT-01";
let activeBodegaArea = "ALL";
let pendingCommitCallback = null;
let pendingEmailPayload = null;
let pendingCommitPermiso = null;
let currentMailtoUrl = "";
let selectedPdfData = null;
let selectedInsumosPdfData = null;

function renderIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
    }
}

// =====================================================================
// INICIALIZACIÓN
// =====================================================================
window.addEventListener("DOMContentLoaded", async () => {
    // Si hay login configurado, la sessión se valida antes de mostrar los datos.
    if (window.Auth && typeof Auth.iniciar === "function") {
        await Auth.iniciar();
    }
    inicializarApp();
});

function inicializarApp() {
    populatePlantasSelectors();
    loadConfigForm();
    renderConfigPlantasList();

    renderOrdenSalidaBase();
    addMaterialRow("sol-items-body", "Tela");

    updateLiveRoutingSummary();
    aplicarItemsConfirmadosAFichas();
    aplicarFirmasDespachosASolicitudes();
    updatePendientesBadges();
    aplicarPermisosAuth();
    switchRole(currentRole);
    renderIcons();
}

window.addEventListener("load", renderIcons);

function saveAllState() {
    const sync = Promise.all([
        DataStore.save(DataStore.KEYS.CONFIG, appConfig),
        DataStore.save(DataStore.KEYS.PLANTAS, appPlantas),
        DataStore.save(DataStore.KEYS.FICHAS, appFichas),
        DataStore.save(DataStore.KEYS.SOLICITUDES, appSolicitudes)
    ]);
    updatePendientesBadges();
    return sync;
}

// La planta confirma "Recibido (Sí/No)" y "Estado" por ítem al firmar desde el
// enlace del correo. Esos datos se guardan en produccion_firmas/{id} junto con
// la firma. Aquí se integran a la ficha en memoria para que se reflejen en la
// remisión, los listados y las exportaciones sin reescribir la ficha completa.
function aplicarItemsConfirmadosAFichas() {
    (appFichas || []).forEach(f => {
        const firma = appFirmas ? appFirmas[f.id] : null;
        const confirmados = firma && Array.isArray(firma.items) ? firma.items : null;
        if (!confirmados || !Array.isArray(f.items)) return;
        f.items = f.items.map((it, idx) => {
            const c = confirmados.find(x => x && (
                x.index === idx ||
                (!("index" in x) && String(x.material || "") === String(it.material || it.desc || ""))
            ));
            if (!c || (!c.recibido && !c.estado && !c.observacion)) return it;
            return {
                ...it,
                recibido: c.recibido || it.recibido || "",
                estado: c.estado || it.estado || "",
                observacionPlanta: c.observacion || "",
                confirmadoPorPlanta: true,
                fechaConfirmacion: firma.itemsConfirmadosAt || firma.fecha || ""
            };
        });
        f.itemsConfirmadosAt = firma.itemsConfirmadosAt || f.itemsConfirmadosAt || "";
    });
}

// Las firmas de los despachos se guardan en otro nodo de Firebase para no
// mezclarlas con las de la salida inicial. Aquí se integran en memoria.
function aplicarFirmasDespachosASolicitudes() {
    (appSolicitudes || []).forEach(s => {
        const firma = appFirmasDespachos ? appFirmasDespachos[s.id] : null;
        if (!firma) return;
        s.firmaRecibido = {
            nombre: firma.nombre || "",
            cedula: firma.cedula || "",
            cargo: firma.cargo || "",
            fecha: firma.fecha || "",
            items: Array.isArray(firma.items) ? firma.items : [],
            itemsConfirmadosAt: firma.itemsConfirmadosAt || ""
        };
    });
}

function updatePendientesBadges() {
    const pendCount = appSolicitudes.filter(s => s.estado === "Pendiente").length;
    const badge = document.getElementById("badge-pendientes-count");
    const subtabBadge = document.getElementById("subtab-pend-badge");
    if (badge) badge.textContent = pendCount;
    if (subtabBadge) subtabBadge.textContent = pendCount;
}

// =====================================================================
// PERMISOS POR USUARIO (GOOGLE SHEETS / AUTH)
// =====================================================================
function conAuth() {
    return !!(window.Auth && typeof Auth.habilitado === "function" && Auth.habilitado());
}

function puedeHacer(permiso) {
    if (!conAuth()) return true;
    return Auth.tiene(permiso);
}

function puedeVerVista(vista) {
    if (!conAuth()) return true;
    return Auth.vistasPermitidas().indexOf(vista) >= 0;
}

// Solo el usuario PLANTA al que pertenece el documento puede abrir el enlace
// de firma desde la interfaz. ADMIN y LECTURA ven el estado, pero no firman.
function plantaAutorizadaParaFirmar(registro) {
    if (!conAuth()) return true;
    const s = Auth.sesion();
    if (!s || s.rol !== "PLANTA" || !s.plantaId) return false;
    return s.plantaId === String(registro?.plantaId || "");
}

function nombrePlantaRegistro(registro) {
    if (registro?.plantaNombre) return registro.plantaNombre;
    const planta = (appPlantas || []).find(p => p.id === registro?.plantaId);
    return planta ? planta.nombre : "la planta asignada";
}

function requierePermiso(permiso, area) {
    if (!puedeHacer(permiso)) {
        showToast("Tu usuario no tiene permiso para realizar esta acción.");
        return false;
    }
    if (permiso === "despachar" && area && conAuth() && !Auth.puedeDespacharArea(area)) {
        showToast("Tu usuario solo puede despachar materiales de su área.");
        return false;
    }
    return true;
}

function aplicarPermisosAuth() {
    const activo = conAuth();
    const s = activo ? Auth.sesion() : null;

    const userBox = document.getElementById("auth-user-box");
    if (userBox) {
        userBox.classList.toggle("hidden", !s);
        userBox.classList.toggle("flex", !!s);
    }
    if (s) {
        const rolChip = document.getElementById("auth-rol-chip");
        const nombreChip = document.getElementById("auth-nombre");
        if (rolChip) rolChip.textContent = Auth.etiquetaRol(s.rol);
        if (nombreChip) nombreChip.textContent = s.nombre || s.usuario;
    }

    const crearUsuarioBtn = document.getElementById("auth-crear-usuario-btn");
    if (crearUsuarioBtn) {
        crearUsuarioBtn.classList.toggle("hidden", !s || s.rol !== "ADMIN");
    }

    const vistas = activo ? Auth.vistasPermitidas() : ["central", "planta"];
    if (vistas.indexOf(currentRole) < 0) currentRole = vistas[0] || "central";

    const btnCentral = document.getElementById("role-btn-central");
    const btnPlanta = document.getElementById("role-btn-planta");
    if (btnCentral) btnCentral.classList.toggle("hidden", vistas.indexOf("central") < 0);
    if (btnPlanta) btnPlanta.classList.toggle("hidden", vistas.indexOf("planta") < 0);

    const tabEnviar = document.getElementById("cen-tab-enviar");
    const tabDespachos = document.getElementById("cen-tab-despachos");
    const tabConfig = document.getElementById("cen-tab-config");
    if (tabEnviar) tabEnviar.classList.toggle("hidden", !puedeHacer("fichas"));
    if (tabDespachos) tabDespachos.classList.toggle("hidden", vistas.indexOf("central") < 0);
    if (tabConfig) tabConfig.classList.toggle("hidden", !puedeHacer("configurar"));

    const fichaCard = document.getElementById("ficha-form-card");
    if (fichaCard) fichaCard.classList.toggle("hidden", !puedeHacer("fichas"));
    const solicitudCard = document.getElementById("plt-solicitud-card");
    if (solicitudCard) solicitudCard.classList.toggle("hidden", !puedeHacer("solicitar"));

    const filtros = {
        ALL: document.getElementById("bod-filter-ALL"),
        TELA: document.getElementById("bod-filter-TELA"),
        INSUMO: document.getElementById("bod-filter-INSUMO")
    };
    Object.keys(filtros).forEach(area => {
        if (!filtros[area]) return;
        const permitido = !s || s.rol === "ADMIN" || s.rol === "LECTURA" || Auth.puedeDespacharArea(area);
        filtros[area].classList.toggle("hidden", !permitido);
    });

    if (s && s.rol === "TELAS") activeBodegaArea = "TELA";
    if (s && s.rol === "INSUMOS") activeBodegaArea = "INSUMO";
    if (s && s.rol === "PLANTA" && s.plantaId) {
        activePlantaId = s.plantaId;
        const selector = document.getElementById("active-planta-selector");
        if (selector) {
            selector.value = s.plantaId;
            Array.from(selector.options || []).forEach(op => {
                op.disabled = op.value !== s.plantaId;
                op.hidden = op.value !== s.plantaId;
            });
        }
        const plantaAsignada = appPlantas.find(p => p.id === s.plantaId);
        const ciudad = document.getElementById("active-planta-ciudad");
        if (plantaAsignada && ciudad) {
            ciudad.textContent = `${plantaAsignada.ciudad} • Contacto: ${plantaAsignada.contacto} (${plantaAsignada.email})`;
        }
    }

    // Si el usuario entró en una pestaña que ya no puede ver, se abre una válida.
    const panelEnviar = document.getElementById("cen-panel-enviar");
    const panelConfig = document.getElementById("cen-panel-config");
    if (panelEnviar && !panelEnviar.classList.contains("hidden") && !puedeHacer("fichas")) {
        switchSubTab("cen", vistas.indexOf("central") >= 0 ? "despachos" : "enviar");
    }
    if (panelConfig && !panelConfig.classList.contains("hidden") && !puedeHacer("configurar")) {
        switchSubTab("cen", puedeHacer("fichas") ? "enviar" : "despachos");
    }
}

// =====================================================================
// CONMUTADOR DE VISTAS (GESTIÓN CENTRAL vs PLANTA EXTERNA)
// =====================================================================
function switchRole(role) {
    if (!puedeVerVista(role)) {
        showToast("Tu usuario no tiene acceso a esta vista.");
        return;
    }
    currentRole = role;
    document.querySelectorAll(".role-view").forEach(el => el.classList.add("hidden"));
    document.getElementById(`role-view-${role}`).classList.remove("hidden");

    const badge = document.getElementById("role-badge-header");

    ["central", "planta"].forEach(r => {
        const btn = document.getElementById(`role-btn-${r}`);
        btn.classList.remove("bg-yellow-400", "text-zinc-950", "font-extrabold", "font-bold", "shadow-sm", "text-zinc-300", "hover:text-white", "hover:bg-zinc-800");
        if (r === role) {
            btn.classList.add("bg-yellow-400", "text-zinc-950", "font-extrabold", "shadow-sm");
        } else {
            btn.classList.add("text-zinc-300", "hover:text-white", "hover:bg-zinc-800", "font-bold");
        }
    });

    if (role === "central") {
        badge.textContent = "Gestión Central";
        badge.className = "text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full bg-yellow-400/15 text-yellow-400 border border-yellow-400/40 lg:ml-2";
        renderCentralView();
    } else {
        badge.textContent = "Planta Externa";
        badge.className = "text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full bg-white/15 text-white border border-white/30 lg:ml-2";
        renderPlantaView();
    }

    renderIcons();
}

function switchSubTab(prefix, tabName) {
    if (prefix === "cen" && tabName === "config" && !puedeHacer("configurar")) {
        showToast("Solo un administrador puede editar destinatarios y plantas.");
        return;
    }
    if (prefix === "cen" && tabName === "enviar" && !puedeHacer("fichas")) {
        showToast("Tu usuario no puede crear fichas ni salidas iniciales.");
        return;
    }
    document.querySelectorAll(`.${prefix}-panel`).forEach(p => p.classList.add("hidden"));
    document.getElementById(`${prefix}-panel-${tabName}`).classList.remove("hidden");

    document.querySelectorAll(`.${prefix}-subtab`).forEach(b => {
        b.classList.remove("bg-zinc-950", "text-yellow-400", "font-extrabold", "shadow-sm");
        b.classList.add("bg-zinc-100", "text-zinc-700", "font-bold");
    });

    const activeBtn = document.getElementById(`${prefix}-tab-${tabName}`);
    activeBtn.classList.remove("bg-zinc-100", "text-zinc-700", "font-bold");
    activeBtn.classList.add("bg-zinc-950", "text-yellow-400", "font-extrabold", "shadow-sm");

    if (tabName === "despachos") renderBodegaView();
    if (tabName === "enviar") renderCentralView();
    renderIcons();
}

// =====================================================================
// PLANTAS EXTERNAS Y SELECTORES
// =====================================================================
function populatePlantasSelectors() {
    const fsSelect = document.getElementById("fs-planta-id");
    const activeSelect = document.getElementById("active-planta-selector");

    const optionsHtml = appPlantas.map(p =>
        `<option value="${p.id}">${p.nombre} (${String(p.ciudad || "").split("-")[0].trim()})</option>`
    ).join("");

    fsSelect.innerHTML = optionsHtml;
    activeSelect.innerHTML = optionsHtml;
    if (appPlantas.some(p => p.id === activePlantaId)) {
        activeSelect.value = activePlantaId;
    }
    syncPlantaEmail();
    onActivePlantaChange();
}

function syncPlantaEmail() {
    const pId = document.getElementById("fs-planta-id").value;
    const planta = appPlantas.find(p => p.id === pId);
    if (planta) {
        document.getElementById("fs-email").value = planta.email;
    }
}

function onActivePlantaChange() {
    activePlantaId = document.getElementById("active-planta-selector").value;
    if (conAuth()) {
        const s = Auth.sesion();
        if (s && s.rol === "PLANTA" && s.plantaId && activePlantaId !== s.plantaId) {
            activePlantaId = s.plantaId;
            document.getElementById("active-planta-selector").value = s.plantaId;
            showToast("Tu usuario solo puede consultar la planta asignada.");
        }
    }
    const planta = appPlantas.find(p => p.id === activePlantaId);
    if (planta) {
        document.getElementById("active-planta-ciudad").textContent = `${planta.ciudad} • Contacto: ${planta.contacto} (${planta.email})`;
    }
    renderPlantaView();
}

function renderConfigPlantasList() {
    const container = document.getElementById("config-plantas-list");
    container.innerHTML = appPlantas.map(p => `
        <div class="p-3 rounded-xl bg-zinc-50 border border-zinc-200 text-xs flex items-start justify-between gap-2">
            <div>
                <div class="font-extrabold text-zinc-950">${p.nombre}</div>
                <div class="text-zinc-500">${p.ciudad} • ${p.contacto}</div>
                <div class="font-mono text-[11px] text-zinc-800 font-semibold mt-0.5">${p.email}</div>
            </div>
            <span class="px-2 py-0.5 rounded bg-zinc-900 text-yellow-400 font-mono font-bold text-[10px]">${p.id}</span>
        </div>
    `).join("");
}

function addNewPlanta(e) {
    e.preventDefault();
    if (!requierePermiso("configurar")) return;
    const newPlanta = {
        id: `PLT-0${appPlantas.length + 1}`,
        nombre: document.getElementById("new-plt-nombre").value.trim(),
        ciudad: document.getElementById("new-plt-ciudad").value.trim(),
        contacto: document.getElementById("new-plt-contacto").value.trim(),
        email: document.getElementById("new-plt-email").value.trim()
    };
    appPlantas.push(newPlanta);
    saveAllState();
    populatePlantasSelectors();
    renderConfigPlantasList();
    e.target.reset();
    showToast(`Planta "${newPlanta.nombre}" registrada`);
}

// =====================================================================
// TABLAS DINÁMICAS DE MATERIALES
// =====================================================================
const MATERIALES_ENTREGA = [
    "Bultos de piezas cortadas",
    "Plantillas y Molderia",
    "Set de tallas",
    "Retazo de tela",
    "Insumos y etiquetas",
    "Muestra Fisica"
];

function renderOrdenSalidaBase() {
    const tbody = document.getElementById("fs-items-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    MATERIALES_ENTREGA.forEach(material => addMaterialRow("fs-items-body", material));
}

function addMaterialRow(tbodyId, defaultType = "Tela") {
    const tbody = document.getElementById(tbodyId);
    const tr = document.createElement("tr");
    tr.className = "hover:bg-zinc-50 transition-colors";
    const isSolicitud = tbodyId === "sol-items-body";
    const isOrdenSalida = tbodyId === "fs-items-body";

    if (isOrdenSalida) {
        const material = MATERIALES_ENTREGA.includes(defaultType) ? defaultType : "";
        tr.innerHTML = `
            <td class="p-2">
                <input type="text" list="materiales-entrega-list" value="${material}" placeholder="Seleccione o escriba..." class="item-material w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-semibold focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2">
                <input type="number" step="0.01" min="0" placeholder="0" class="item-cant w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2">
                <select class="item-unidad w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
                    <option value="Unidades" selected>Unidades</option>
                    <option value="Kits">Kits</option>
                    <option value="Juegos">Juegos</option>
                    <option value="Pares">Pares</option>
                    <option value="Docenas">Docenas</option>
                    <option value="Metros">Metros</option>
                    <option value="Kilos">Kilos</option>
                    <option value="Rollos">Rollos</option>
                    <option value="Conos">Conos</option>
                </select>
            </td>
            <td class="p-2">
                <select class="item-recibido w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
                    <option value="">Elegir</option>
                    <option value="Sí">Sí</option>
                    <option value="No">No</option>
                </select>
            </td>
            <td class="p-2">
                <select class="item-estado w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
                    <option value="">Elegir</option>
                    <option value="Completo">Completo</option>
                    <option value="Incompleto">Incompleto</option>
                    <option value="Buen estado">Buen estado</option>
                    <option value="Con novedad">Con novedad</option>
                    <option value="No aplica">No aplica</option>
                </select>
            </td>
            <td class="p-2">
                <input type="text" placeholder="Observación" class="item-obs w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2 text-center">
                <button type="button" onclick="removeMaterialRow(this, false)" class="p-1.5 text-zinc-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </td>
        `;
    } else {
        tr.innerHTML = `
            <td class="p-2">
                <select onchange="${isSolicitud ? "updateLiveRoutingSummary()" : ""}" class="item-tipo w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs font-extrabold focus:ring-2 focus:ring-yellow-400 outline-none">
                    <option value="Tela" ${defaultType === "Tela" ? "selected" : ""}>Tela</option>
                    <option value="Insumo" ${defaultType === "Insumo" ? "selected" : ""}>Insumo</option>
                </select>
            </td>
            <td class="p-2">
                <input type="text" required placeholder="Ej: Jersey 240g / Hilo Cal. 120" class="item-desc w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2">
                <input type="text" placeholder="Blanco / L-01" class="item-color w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2">
                <input type="number" step="0.01" min="0.1" required placeholder="0" class="item-cant w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
            <td class="p-2">
                <select class="item-unidad w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs focus:ring-2 focus:ring-yellow-400 outline-none">
                    <option value="Metros" ${defaultType === "Tela" ? "selected" : ""}>Metros</option>
                    <option value="Kilos">Kilos</option>
                    <option value="Unidades" ${defaultType === "Insumo" ? "selected" : ""}>Unidades</option>
                    <option value="Conos">Conos</option>
                    <option value="Rollos">Rollos</option>
                </select>
            </td>
            <td class="p-2 text-center">
                <button type="button" onclick="removeMaterialRow(this, ${isSolicitud})" class="p-1.5 text-zinc-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </td>
        `;
    }

    tbody.appendChild(tr);
    if (isSolicitud) updateLiveRoutingSummary();
    renderIcons();
}

function removeMaterialRow(btn, isSolicitud) {
    const tbody = btn.closest("tbody");
    if (tbody.children.length > 1) {
        btn.closest("tr").remove();
        if (isSolicitud) updateLiveRoutingSummary();
    } else {
        showToast("Debe incluir al menos un material");
    }
}

function extractItemsFromTable(tbodyId) {
    const rows = document.querySelectorAll(`#${tbodyId} tr`);
    const items = [];
    rows.forEach(row => {
        const materialEl = row.querySelector(".item-material");
        const tipoEl = row.querySelector(".item-tipo");
        const descEl = row.querySelector(".item-desc");
        const colorEl = row.querySelector(".item-color");
        const recibidoEl = row.querySelector(".item-recibido");
        const estadoEl = row.querySelector(".item-estado");
        const obsEl = row.querySelector(".item-obs");
        const material = materialEl ? materialEl.value.trim() : "";

        items.push({
            material: material,
            tipo: tipoEl ? tipoEl.value : "Material",
            desc: material || (descEl ? descEl.value.trim() : ""),
            color: colorEl ? (colorEl.value.trim() || "Estándar") : "",
            cant: parseFloat(row.querySelector(".item-cant").value) || 0,
            unidad: row.querySelector(".item-unidad").value,
            recibido: recibidoEl ? recibidoEl.value : "",
            estado: estadoEl ? estadoEl.value : "",
            observacion: obsEl ? obsEl.value.trim() : "",
            cantDespachada: 0
        });
    });
    return items;
}

function formatItemLineForEmail(item, index) {
    if (item.material) {
        const obs = item.observacion ? ` | Obs: ${item.observacion}` : "";
        return `${index + 1}. ${item.material} | Cant: ${item.cant} ${item.unidad} | Recibido: ${item.recibido || "Pendiente"} | Estado: ${item.estado || "Sin estado"}${obs}`;
    }
    return `${index + 1}. [${(item.tipo || "Material").toUpperCase()}] ${item.desc} | Color: ${item.color || "—"} | Cant: ${item.cant} ${item.unidad}`;
}

// =====================================================================
// LECTURA DE PDF PARA ADJUNTO REAL
// =====================================================================
function handleFileSelect(input, tipo = "ficha") {
    const esInsumos = tipo === "insumos";
    const label = document.getElementById(esInsumos ? "fs-insumos-file-label" : "fs-file-label");
    const limpiar = () => {
        if (esInsumos) selectedInsumosPdfData = null;
        else selectedPdfData = null;
    };

    if (!input.files || !input.files[0]) {
        label.textContent = "Seleccionar PDF";
        limpiar();
        return;
    }

    const file = input.files[0];
    label.textContent = file.name;

    if (file.size > 8 * 1024 * 1024) {
        showToast("El archivo supera los 8 MB recomendados para envío por correo");
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
        const base64Content = evt.target.result.split(",")[1];
        const attachment = {
            nombre: file.name,
            mimeType: file.type || "application/pdf",
            base64: base64Content
        };
        if (esInsumos) selectedInsumosPdfData = attachment;
        else selectedPdfData = attachment;
    };
    reader.onerror = function () {
        label.textContent = "Seleccionar PDF";
        limpiar();
        showToast("No se pudo leer el archivo seleccionado");
    };
    reader.readAsDataURL(file);
}

// =====================================================================
// UTILIDADES DE FECHA, FIRMA Y ENLACE PÚBLICO
// =====================================================================
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    }[char]));
}

function formatearFechaHora(valor) {
    const fecha = valor ? new Date(valor) : null;
    if (!fecha || isNaN(fecha.getTime())) return "—";
    return fecha.toLocaleString("es-CO", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    }).replace(/\.$/, "");
}

// La planta tiene dos días hábiles para reportar novedades.
// No se descuentan festivos; si se necesitan, se pueden agregar a esta función.
function calcularFechaLimiteNovedades(fechaBase) {
    const fecha = fechaBase ? new Date(String(fechaBase).replace(" ", "T")) : new Date();
    if (isNaN(fecha.getTime())) return "";
    let diasAgregados = 0;
    while (diasAgregados < 2) {
        fecha.setDate(fecha.getDate() + 1);
        const dia = fecha.getDay();
        if (dia !== 0 && dia !== 6) diasAgregados++;
    }
    return fecha.toISOString();
}

// Relaciona la solicitud con la ficha de origen para saber si el material se
// pidió después de los dos días hábiles. El lote lo digita la planta, así que
// solo se usa como pista cuando coincide con el ID de la ficha.
function evaluarPlazoMaterial(ref, lote) {
    const candidatas = appFichas.filter(f => f.referencia === ref);
    const ficha = candidatas.find(f => f.id === lote) || candidatas[candidatas.length - 1] || null;
    if (!ficha) return { ficha: null, fechaLimite: "", fueraDePlazo: false };

    const limiteRaw = ficha.fechaLimiteNovedades || calcularFechaLimiteNovedades(ficha.fecha);
    const limite = limiteRaw ? new Date(String(limiteRaw).replace(" ", "T")) : null;
    const vencido = !!limite && !isNaN(limite.getTime()) && Date.now() > limite.getTime();
    return {
        ficha,
        fechaLimite: limite && !isNaN(limite.getTime()) ? limite.toISOString() : "",
        fueraDePlazo: vencido
    };
}

function obtenerBaseUrlPublica() {
    const configurada = String(APP_SYSTEM.publicBaseUrl || "").trim() || String(appConfig.publicBaseUrl || "").trim();
    if (configurada) return configurada.replace(/\/+$/, "") + "/";
    if (location.protocol === "file:") return "";
    return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`;
}

function lineaUrlPlataforma() {
    const base = obtenerBaseUrlPublica();
    return base ? `PORTAL DE PRODUCCIÓN (ingreso con usuario y clave): ${base}\n` : "";
}

function generarTokenFirma() {
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function construirUrlFirma(fichaId, token) {
    const base = obtenerBaseUrlPublica();
    if (!base) return "";
    return `${base}firmar.html?id=${encodeURIComponent(fichaId)}&token=${encodeURIComponent(token)}`;
}

function construirUrlFirmaSolicitud(solicitudId, token) {
    const base = obtenerBaseUrlPublica();
    if (!base) return "";
    return `${base}firmar.html?tipo=despacho&id=${encodeURIComponent(solicitudId)}&token=${encodeURIComponent(token)}`;
}

// =====================================================================
// GESTIÓN CENTRAL: ENVÍO FICHA TÉCNICA + SALIDA
// =====================================================================
function handlePreviewFichaSalida(e) {
    e.preventDefault();
    if (!requierePermiso("fichas")) return;
    const plantaId = document.getElementById("fs-planta-id").value;
    const planta = appPlantas.find(p => p.id === plantaId);
    if (!planta) {
        showToast("Selecciona una planta externa válida");
        return;
    }
    const ref = document.getElementById("fs-ref").value.trim();
    const cantPrendas = parseInt(document.getElementById("fs-cantidad-prendas").value) || 0;
    const prenda = document.getElementById("fs-prenda").value.trim();
    const cliente = document.getElementById("fs-cliente").value.trim();
    const emailTo = document.getElementById("fs-email").value.trim();
    const notas = document.getElementById("fs-notas").value.trim();
    const fileUrl = document.getElementById("fs-file-url").value.trim();
    const insumosUrl = document.getElementById("fs-insumos-file-url").value.trim();

    let archivoFicha = `FichaTecnica_${ref}.pdf`;
    if (selectedPdfData) archivoFicha = selectedPdfData.nombre;
    else if (fileUrl) archivoFicha = fileUrl;

    let archivoInsumos = "";
    if (selectedInsumosPdfData) archivoInsumos = selectedInsumosPdfData.nombre;
    else if (insumosUrl) archivoInsumos = insumosUrl;

    const items = extractItemsFromTable("fs-items-body");
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    const ftId = `FT-${Math.floor(1000 + Math.random() * 8999)}`;
    const firmaToken = generarTokenFirma();
    const firmaUrl = construirUrlFirma(ftId, firmaToken);
    const fechaLimiteNovedades = calcularFechaLimiteNovedades(now);

    const ccList = `${appConfig.telaEmail}, ${appConfig.insumoEmail}, ${appConfig.ingEmail}`;
    const itemsText = items.map((it, i) => formatItemLineForEmail(it, i)).join("\n");

    const subject = `[FICHA TÉCNICA + SALIDA] ${ref} - ${prenda} | ${APP_SYSTEM.empresa}`;
    const body = `Estimados ${planta.nombre} (${planta.contacto}),\n\n` +
        lineaUrlPlataforma() +
        `\n` +
        `Desde el área de ${APP_SYSTEM.nombreApp} de ${APP_SYSTEM.empresa} (${APP_SYSTEM.nit || "NIT. 901.367.620-0"}), remitimos la Ficha Técnica y la Orden de Salida Inicial de materiales:\n\n` +
        `====================================================\n` +
        `ID REMISIÓN: ${ftId}\n` +
        `PLANTA EXTERNA: ${planta.nombre}\n` +
        `REFERENCIA: ${ref} (${cantPrendas} unidades)\n` +
        `PRENDA: ${prenda} (${cliente})\n` +
        `FICHA TÉCNICA: ${archivoFicha}\n` +
        `SALIDA DE INSUMOS: ${archivoInsumos || "No adjunta"}\n` +
        `====================================================\n\n` +
        `MATERIALES AUTORIZADOS EN SALIDA INICIAL:\n` +
        `${itemsText}\n\n` +
        (notas ? `ESPECIFICACIONES DE PRODUCCIÓN:\n${notas}\n\n` : "") +
        `PLAZO PARA REPORTAR NOVEDADES: dos días hábiles (hasta ${formatearFechaHora(fechaLimiteNovedades)}). Pasado ese plazo se entiende recibido conforme.\n` +
        `ENLACE PARA FIRMAR ELECTRÓNICAMENTE EL RECIBIDO (Recibido y Estado por material):\n${firmaUrl || "Enlace disponible cuando el sitio esté publicado."}\n` +
        `En ese enlace la planta marca Recibido (Sí/No) y Estado de cada material antes de firmar.\n\n` +
        `Para solicitar reposiciones o reportar avance, ingrese al portal Planta Externa.\n\nAtentamente,\n${appConfig.ingNombre}`;

    const newFicha = {
        id: ftId,
        fecha: now,
        plantaId: planta.id,
        plantaNombre: planta.nombre,
        referencia: ref,
        prenda: prenda,
        cliente: cliente,
        cantidadPrendas: cantPrendas,
        unidadesTerminadas: 0,
        notaAvance: "",
        emailPlanta: emailTo,
        archivoFicha: archivoFicha,
        archivoInsumos: archivoInsumos,
        notas: notas,
        items: items,
        firmaToken: firmaToken,
        firmaUrl: firmaUrl,
        fechaLimiteNovedades: fechaLimiteNovedades
    };

    pendingEmailPayload = {
        tipoEvento: "FICHA_SALIDA",
        para: emailTo,
        cc: ccList,
        asunto: subject,
        cuerpo: body,
        // Formato nuevo: ambos adjuntos. El Apps Script actualizado los procesa.
        adjuntosPdf: [selectedPdfData, selectedInsumosPdfData].filter(Boolean),
        // Compatibilidad con despliegues anteriores del Script.
        adjuntoPdf: selectedPdfData,
        enlaceDrive: fileUrl,
        enlacesDrive: [fileUrl, insumosUrl].filter(Boolean),
        firmaUrl: firmaUrl,
        firmaToken: firmaToken,
        fechaLimiteNovedades: fechaLimiteNovedades
    };
    const emailPayload = pendingEmailPayload;

    pendingCommitCallback = async () => {
        appFichas.unshift(newFicha);
        await saveAllState();
        let correoOk = true;
        try {
            await DataStore.enviarCorreoConPdf(emailPayload);
        } catch (err) {
            correoOk = false;
            console.error("Error enviando ficha por correo:", err);
        }

        document.getElementById("form-ficha-salida").reset();
        document.getElementById("fs-file-label").textContent = "Seleccionar PDF";
        document.getElementById("fs-insumos-file-label").textContent = "Seleccionar PDF";
        selectedPdfData = null;
        selectedInsumosPdfData = null;
        renderOrdenSalidaBase();
        syncPlantaEmail();
        renderCentralView();
        if (currentRole === "planta") renderPlantaView();
        showToast(correoOk
            ? `Ficha ${ftId} enviada a ${planta.nombre}`
            : `Ficha ${ftId} guardada. El correo automático falló, usa "Abrir correo"`);
    };

    openEmailModal(emailTo, ccList, subject, body, [archivoFicha, archivoInsumos].filter(Boolean), false, "fichas");
}

function renderCentralView() {
    document.getElementById("ing-kpi-fichas").textContent = appFichas.length;
    document.getElementById("ing-kpi-pend-telas").textContent = appSolicitudes.filter(s => s.estado === "Pendiente" && s.area === "TELA").length;
    document.getElementById("ing-kpi-pend-insumos").textContent = appSolicitudes.filter(s => s.estado === "Pendiente" && s.area === "INSUMO").length;
    document.getElementById("ing-kpi-despachados").textContent = appSolicitudes.filter(s => s.estado === "Despachado").length;

    const searchInput = document.getElementById("search-fichas-input");
    const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const texto = value => String(value ?? "").toLowerCase();
    const filteredFichas = appFichas.filter(f =>
        !term ||
        texto(f.referencia).includes(term) ||
        texto(f.prenda).includes(term) ||
        texto(f.plantaNombre).includes(term) ||
        texto(f.id).includes(term)
    );

    const fTbody = document.getElementById("ing-fichas-tbody");
    if (filteredFichas.length === 0) {
        fTbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-zinc-400 text-xs">No hay órdenes registradas que coincidan con la búsqueda.</td></tr>`;
    } else {
        fTbody.innerHTML = filteredFichas.map(f => {
            const terminadas = totalAvance(f);
            const pct = porcentajeAvance(f);
            return `
                <tr class="hover:bg-zinc-50">
                    <td class="py-3 px-4">
                        <div class="font-extrabold text-zinc-950 text-xs">${f.id}</div>
                        <div class="text-[11px] text-zinc-400">${f.fecha}</div>
                    </td>
                    <td class="py-3 px-4 font-bold text-xs text-zinc-900">${f.plantaNombre}</td>
                    <td class="py-3 px-4">
                        <div class="font-extrabold text-xs text-zinc-950">${f.referencia} (${f.cantidadPrendas} und)</div>
                        <div class="text-xs text-zinc-500">${f.prenda}</div>
                    </td>
                    <td class="py-3 px-4 w-44">
                        <button type="button" onclick="verDesgloseAvance('${f.id}')" class="w-full text-left group" title="Ver desglose por talla">
                            <div class="flex items-center justify-between text-[11px] font-bold mb-1">
                                <span class="text-zinc-700">${terminadas} / ${f.cantidadPrendas}</span>
                                <span class="${pct === 100 ? "text-emerald-600" : "text-yellow-700"}">${pct}%</span>
                            </div>
                            <div class="w-full h-2 bg-zinc-200 rounded-full overflow-hidden">
                                <div class="h-full ${pct === 100 ? "bg-emerald-500" : "bg-yellow-400"}" style="width: ${pct}%"></div>
                            </div>
                            <span class="inline-flex items-center gap-1 mt-1 text-[10px] font-bold text-zinc-500 group-hover:text-zinc-950">
                                <i data-lucide="list" class="w-3 h-3"></i> Ver tallas
                            </span>
                        </button>
                    </td>
                    <td class="py-3 px-4">
                        <div class="flex flex-col gap-1">
                            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 text-zinc-800 text-xs font-semibold">
                                <i data-lucide="file-text" class="w-3.5 h-3.5 text-yellow-600"></i> ${f.archivoFicha}
                            </span>
                            ${f.archivoInsumos ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-50 text-zinc-800 text-xs font-semibold">
                                <i data-lucide="package" class="w-3.5 h-3.5 text-yellow-600"></i> ${f.archivoInsumos}
                            </span>` : ""}
                            ${appFirmas[f.id]
                                ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-semibold" title="Firmada por ${escapeHtml(appFirmas[f.id].nombre || "planta")}${Array.isArray(appFirmas[f.id].items) && appFirmas[f.id].items.length ? ` · ${appFirmas[f.id].items.length} ítem(s) confirmado(s)` : ""}">
                                    <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> Firmada${Array.isArray(appFirmas[f.id].items) && appFirmas[f.id].items.length ? " · Ítems OK" : ""}
                                </span>`
                                : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 text-xs font-semibold" title="Pendiente de firma por ${escapeHtml(f.plantaNombre || nombrePlantaRegistro(f))}">
                                    <i data-lucide="clock" class="w-3.5 h-3.5"></i> Firma pendiente
                                </span>`}
                        </div>
                    </td>
                    <td class="py-3 px-4 text-right">
                        <button type="button" onclick="viewFichaDetail('${f.id}')" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-zinc-950 text-yellow-400 hover:bg-zinc-800" title="Ver / Imprimir Remisión">
                            <i data-lucide="printer" class="w-3.5 h-3.5"></i> Remisión
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    }

    renderBodegaView();
    renderIcons();
}

function csvCell(valor) {
    return `"${String(valor ?? "").replace(/"/g, '""')}"`;
}

function exportarFichasCSV() {
    aplicarItemsConfirmadosAFichas();
    if (appFichas.length === 0) {
        showToast("No hay órdenes para exportar");
        return;
    }
    const headers = ["ID Orden", "Fecha", "Planta Externa", "Referencia", "Prenda", "Cliente", "Unidades Totales", "Unidades Terminadas", "Avance %", "Avance por Talla", "Ficha Tecnica", "Salida Insumos", "Recibido (ítems)", "Estado (ítems)"];
    const rows = appFichas.map(f => {
        const term = totalAvance(f);
        const pct = porcentajeAvance(f);
        const tallas = obtenerAvancePorTalla(f).map(a => `${a.talla}: ${parseInt(a.unidades, 10) || 0}`).join(" / ");
        return [
            f.id,
            f.fecha,
            csvCell(f.plantaNombre),
            f.referencia,
            csvCell(f.prenda),
            csvCell(f.cliente),
            f.cantidadPrendas,
            term,
            `${pct}%`,
            csvCell(tallas),
            csvCell(f.archivoFicha),
            csvCell(f.archivoInsumos || ""),
            csvCell((f.items || []).map(i => i.recibido || "—").join(" / ")),
            csvCell((f.items || []).map(i => i.estado || "—").join(" / "))
        ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Produccion_Crearte_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast("Reporte descargado en formato Excel (CSV)");
}

// =====================================================================
// PORTAL PLANTA EXTERNA
// =====================================================================
function updateLiveRoutingSummary() {
    const rows = document.querySelectorAll("#sol-items-body tr");
    let telasCount = 0;
    let insumosCount = 0;
    rows.forEach(r => {
        const t = r.querySelector(".item-tipo").value;
        if (t === "Tela") telasCount++;
        else insumosCount++;
    });

    const box = document.getElementById("live-routing-summary");
    let lines = [];
    if (telasCount > 0) {
        lines.push(`<div class="flex items-center gap-2 text-zinc-900"><i data-lucide="layers" class="w-4 h-4 text-yellow-600 flex-shrink-0"></i> <span><strong>${telasCount} ítem(s) de TELA</strong> → <strong>${appConfig.telaNombre}</strong> (${appConfig.telaEmail})</span></div>`);
    }
    if (insumosCount > 0) {
        lines.push(`<div class="flex items-center gap-2 text-zinc-900"><i data-lucide="component" class="w-4 h-4 text-zinc-700 flex-shrink-0"></i> <span><strong>${insumosCount} ítem(s) de INSUMO</strong> → <strong>${appConfig.insumoNombre}</strong> (${appConfig.insumoEmail})</span></div>`);
    }
    if (telasCount > 0 && insumosCount > 0) {
        lines.push(`<div class="pt-1 mt-1 border-t border-zinc-200 text-[11px] font-bold text-zinc-800 flex items-center gap-1.5"><i data-lucide="git-fork" class="w-3.5 h-3.5 text-yellow-600"></i> Pedido mixto: Se creará 1 ticket para Bodega de Telas y 1 ticket para Almacén de Insumos.</div>`);
    }
    box.innerHTML = lines.join("");
    renderIcons();
}

function handlePreviewSolicitudPlanta(e) {
    e.preventDefault();
    if (!requierePermiso("solicitar")) return;
    const planta = appPlantas.find(p => p.id === activePlantaId);
    if (!planta) {
        showToast("Selecciona una planta externa válida");
        return;
    }
    const ref = document.getElementById("sol-ref").value.trim();
    const lote = document.getElementById("sol-lote").value.trim();
    const motivo = document.getElementById("sol-motivo-tipo").value;
    const urgencia = document.getElementById("sol-urgencia").value;
    const notas = document.getElementById("sol-notas").value.trim();
    const plazo = evaluarPlazoMaterial(ref, lote);

    const allItems = extractItemsFromTable("sol-items-body");
    const telaItems = allItems.filter(i => i.tipo === "Tela");
    const insumoItems = allItems.filter(i => i.tipo === "Insumo");

    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    const ticketsToCreate = [];
    let emailToList = [];
    let emailBodySections = [];

    if (telaItems.length > 0) {
        const solTId = `SOL-T-${Math.floor(300 + Math.random() * 699)}`;
        ticketsToCreate.push({
            id: solTId,
            fecha: now,
            plantaId: planta.id,
            plantaNombre: planta.nombre,
            emailPlanta: planta.email || "",
            area: "TELA",
            referencia: ref,
            lote: lote,
            fichaIdOrigen: plazo.ficha?.id || "",
            fechaLimiteMateriales: plazo.fechaLimite,
            fueraDePlazo: plazo.fueraDePlazo,
            motivo: motivo,
            urgencia: urgencia,
            estado: "Pendiente",
            notas: notas,
            items: telaItems,
            despachoInfo: null
        });
        emailToList.push(appConfig.telaEmail);
        const tLines = telaItems.map((it, idx) => `  ${idx + 1}. ${it.desc} | Color: ${it.color} | Cant: ${it.cant} ${it.unidad}`).join("\n");
        emailBodySections.push(`>>> SOLICITUD BODEGA DE TELAS (${solTId})\n${tLines}`);
    }

    if (insumoItems.length > 0) {
        const solIId = `SOL-I-${Math.floor(300 + Math.random() * 699)}`;
        ticketsToCreate.push({
            id: solIId,
            fecha: now,
            plantaId: planta.id,
            plantaNombre: planta.nombre,
            emailPlanta: planta.email || "",
            area: "INSUMO",
            referencia: ref,
            lote: lote,
            fichaIdOrigen: plazo.ficha?.id || "",
            fechaLimiteMateriales: plazo.fechaLimite,
            fueraDePlazo: plazo.fueraDePlazo,
            motivo: motivo,
            urgencia: urgencia,
            estado: "Pendiente",
            notas: notas,
            items: insumoItems,
            despachoInfo: null
        });
        emailToList.push(appConfig.insumoEmail);
        const iLines = insumoItems.map((it, idx) => `  ${idx + 1}. ${it.desc} | Color: ${it.color} | Cant: ${it.cant} ${it.unidad}`).join("\n");
        emailBodySections.push(`>>> SOLICITUD ALMACÉN DE INSUMOS (${solIId})\n${iLines}`);
    }

    const isSplit = telaItems.length > 0 && insumoItems.length > 0;
    const subject = `[SOLICITUD MATERIAL - ${urgencia.toUpperCase()}] ${planta.nombre} | Ref: ${ref} | ${APP_SYSTEM.empresa}`;
    const body = `Solicitud de materiales radicada en ${APP_SYSTEM.nombreApp} (${APP_SYSTEM.empresa}):\n\n` +
        lineaUrlPlataforma() +
        `\n` +
        `PLANTA SOLICITANTE: ${planta.nombre} (${planta.ciudad})\n` +
        `REFERENCIA: ${ref} | LOTE/OP: ${lote}\n` +
        `MOTIVO: ${motivo} | URGENCIA: ${urgencia.toUpperCase()}\n` +
        (plazo.fueraDePlazo
            ? `PLAZO DE DOS DÍAS: VENCIDO (${formatearFechaHora(plazo.fechaLimite)}). Esta solicitud queda marcada para cobro; el despacho debe autorizarlo.\n\n`
            : `\n`) +
        `====================================================\n` +
        `${emailBodySections.join("\n\n")}\n` +
        `====================================================\n\n` +
        (notas ? `OBSERVACIONES:\n${notas}\n\n` : "") +
        `Por favor gestionar despacho desde Gestión Central.`;

    pendingEmailPayload = {
        tipoEvento: "SOLICITUD_MATERIAL",
        para: emailToList.join(", "),
        cc: appConfig.ingEmail,
        asunto: subject,
        cuerpo: body,
        adjuntoPdf: null
    };

    const emailPayload = pendingEmailPayload;

    pendingCommitCallback = async () => {
        ticketsToCreate.forEach(t => appSolicitudes.unshift(t));
        saveAllState();
        let correoOk = true;
        try {
            await DataStore.enviarCorreoConPdf(emailPayload);
        } catch (err) {
            correoOk = false;
            console.error("Error enviando solicitud por correo:", err);
        }

        document.getElementById("form-solicitud-planta").reset();
        document.getElementById("sol-items-body").innerHTML = "";
        addMaterialRow("sol-items-body", "Tela");
        updateLiveRoutingSummary();
        renderPlantaView();
        const msg = isSplit ? "Se crearon 2 tickets separados (Telas e Insumos)" : "Solicitud registrada";
        showToast(correoOk ? msg : `${msg}. El correo automático falló, usa "Abrir correo"`);
    };

    openEmailModal(emailToList.join(", "), appConfig.ingEmail, subject, body, null, isSplit, "solicitar");
}

function renderPlantaView() {
    const myFichas = appFichas.filter(f => f.plantaId === activePlantaId);
    const mySolicitudes = appSolicitudes.filter(s => s.plantaId === activePlantaId);

    document.getElementById("plt-fichas-count").textContent = myFichas.length;
    document.getElementById("refs-planta-datalist").innerHTML = myFichas.map(f => `<option value="${f.referencia}">${f.prenda}</option>`).join("");

    const grid = document.getElementById("plt-fichas-grid");
    if (myFichas.length === 0) {
        grid.innerHTML = `<div class="p-6 rounded-xl border border-dashed border-zinc-300 text-center text-zinc-400 text-xs">Esta planta externa aún no tiene fichas técnicas asignadas.</div>`;
    } else {
        grid.innerHTML = myFichas.map(f => {
            const terminadas = totalAvance(f);
            const pct = porcentajeAvance(f);
            return `
                <div class="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 hover:border-yellow-400 hover:bg-white transition-all space-y-3">
                    <div class="flex items-start justify-between gap-2">
                        <span class="px-2.5 py-0.5 rounded-lg bg-zinc-950 text-yellow-400 font-extrabold text-xs">${f.referencia}</span>
                        <span class="text-[11px] text-zinc-400">${f.fecha}</span>
                    </div>
                    <div>
                        <h3 class="font-extrabold text-zinc-950 text-sm">${f.prenda}</h3>
                        <p class="text-[11px] text-zinc-500">${f.cliente} • Lote: <strong>${f.cantidadPrendas} und</strong></p>
                    </div>

                    <!-- Barra de avance (clic para ver desglose por talla) -->
                    <button type="button" onclick="verDesgloseAvance('${f.id}')" class="w-full p-2.5 rounded-xl bg-white border border-zinc-200 hover:border-yellow-400 space-y-1.5 text-left" title="Ver desglose por talla">
                        <div class="flex items-center justify-between text-[11px] font-bold">
                            <span class="text-zinc-600">Avance: ${terminadas} / ${f.cantidadPrendas} und</span>
                            <span class="${pct === 100 ? "text-emerald-600" : "text-zinc-950"}">${pct}%</span>
                        </div>
                        <div class="w-full h-2 bg-zinc-200 rounded-full overflow-hidden">
                            <div class="h-full ${pct === 100 ? "bg-emerald-500" : "bg-yellow-400"}" style="width: ${pct}%"></div>
                        </div>
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold text-zinc-500">
                            <i data-lucide="list" class="w-3 h-3"></i> Ver desglose por talla
                        </span>
                    </button>
                    
                    <div class="p-2.5 rounded-xl bg-white border border-zinc-200 flex items-center justify-between text-xs">
                        <span class="flex items-center gap-1.5 font-semibold text-zinc-700 truncate">
                            <i data-lucide="file-text" class="w-3.5 h-3.5 text-yellow-600 flex-shrink-0"></i>
                            <span class="truncate">${f.archivoFicha}</span>
                        </span>
                        <button type="button" onclick="viewFichaDetail('${f.id}')" class="text-zinc-950 font-extrabold underline decoration-yellow-400 decoration-2 ml-2 flex-shrink-0">Ver Remisión</button>
                    </div>
                    ${f.archivoInsumos ? `<div class="p-2.5 rounded-xl bg-white border border-zinc-200 text-xs">
                        <span class="flex items-center gap-1.5 font-semibold text-zinc-700 truncate">
                            <i data-lucide="package" class="w-3.5 h-3.5 text-yellow-600 flex-shrink-0"></i>
                            <span class="truncate">${f.archivoInsumos}</span>
                        </span>
                    </div>` : ""}
                    <div class="p-2.5 rounded-xl border text-xs ${appFirmas[f.id] ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}">
                        <span class="flex items-center gap-1.5 font-semibold">
                            <i data-lucide="${appFirmas[f.id] ? "check-circle" : "clock"}" class="w-3.5 h-3.5 flex-shrink-0"></i>
                            ${appFirmas[f.id]
                                ? `Firmada por ${escapeHtml(appFirmas[f.id].nombre || "la planta")}${Array.isArray(appFirmas[f.id].items) && appFirmas[f.id].items.length ? ` · ${appFirmas[f.id].items.length} ítem(s) confirmado(s)` : ""}`
                                : "Firma de recibido pendiente"}
                        </span>
                    </div>

                    ${(puedeHacer("avance") || puedeHacer("solicitar")) ? `
                    <div class="pt-2 border-t border-zinc-200/70 grid grid-cols-2 gap-2">
                        ${puedeHacer("avance") ? `
                        <button type="button" onclick="openAvanceModal('${f.id}')" class="inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl text-xs font-bold bg-zinc-950 text-white hover:bg-zinc-800 transition-colors">
                            <i data-lucide="trending-up" class="w-3.5 h-3.5 text-yellow-400"></i> Reportar Avance
                        </button>` : ""}
                        ${puedeHacer("solicitar") ? `
                        <button type="button" onclick="prefillSolicitudFromFicha('${f.id}')" class="inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl text-xs font-extrabold bg-yellow-400 text-zinc-950 hover:bg-yellow-500 shadow-sm transition-colors">
                            <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i> Pedir Material
                        </button>` : ""}
                    </div>` : ""}
                </div>
            `;
        }).join("");
    }

    const tbody = document.getElementById("plt-pedidos-tbody");
    if (mySolicitudes.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-zinc-400 text-xs">No has realizado solicitudes desde esta planta.</td></tr>`;
    } else {
        tbody.innerHTML = mySolicitudes.map(s => {
            const areaBadge = s.area === "TELA"
                ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-extrabold bg-yellow-100 text-zinc-950 border border-yellow-300"><i data-lucide="layers" class="w-3 h-3 text-yellow-700"></i> Telas</span>`
                : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-bold bg-zinc-200 text-zinc-900"><i data-lucide="component" class="w-3 h-3"></i> Insumos</span>`;

            const estadoCell = s.estado === "Despachado"
                ? `<div class="space-y-1">
                       <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800">
                           <i data-lucide="check-circle-2" class="w-3 h-3"></i> Despachado
                       </span>
                       <div class="text-[11px] font-mono text-zinc-900 font-bold">Guía: ${s.despachoInfo?.remision}</div>
                       ${s.firmaRecibido
                           ? `<div class="text-[10px] font-bold text-emerald-700"><i data-lucide="check-circle" class="w-3 h-3 inline"></i> Recibido firmado: ${escapeHtml(s.firmaRecibido.nombre || "planta")}</div>`
                           : s.firmaUrl && plantaAutorizadaParaFirmar(s)
                               ? `<a href="${escapeHtml(s.firmaUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[10px] font-extrabold text-zinc-950 underline decoration-yellow-400 decoration-2"><i data-lucide="pen-line" class="w-3 h-3"></i> Firmar recibido</a>`
                               : `<div class="text-[10px] font-semibold text-amber-700">Pendiente de firma por ${escapeHtml(nombrePlantaRegistro(s))}</div>`}
                   </div>`
                : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-yellow-200 text-zinc-950">
                       <span class="w-1.5 h-1.5 rounded-full bg-zinc-950 animate-pulse"></span> Pendiente
                   </span>`;

            return `
                <tr class="hover:bg-zinc-50">
                    <td class="py-3 px-4">
                        <div class="font-extrabold text-xs text-zinc-950">${s.id}</div>
                        <div class="text-[11px] text-zinc-400">${s.fecha}</div>
                    </td>
                    <td class="py-3 px-4">${areaBadge}</td>
                    <td class="py-3 px-4">
                        <div class="font-bold text-xs text-zinc-900">${s.referencia} (${s.lote})</div>
                        <div class="text-[11px] ${s.fueraDePlazo ? "font-bold text-rose-700" : "text-zinc-500"}">${s.motivo}${s.fueraDePlazo ? " · Fuera del plazo de dos días" : ""}</div>
                    </td>
                    <td class="py-3 px-4 text-xs text-zinc-700">
                        ${(s.items || []).map(i => `<div>• ${i.desc} (<strong>${i.cant} ${i.unidad}</strong>)</div>`).join("")}
                    </td>
                    <td class="py-3 px-4">${estadoCell}</td>
                    <td class="py-3 px-4 text-right">
                        <button type="button" onclick="viewSolicitudDetail('${s.id}')" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-zinc-100 text-zinc-900 hover:bg-yellow-400">
                            <i data-lucide="printer" class="w-3.5 h-3.5"></i> Ver / PDF
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    }
    renderIcons();
}

function prefillSolicitudFromFicha(fichaId) {
    if (!requierePermiso("solicitar")) return;
    const ficha = appFichas.find(f => f.id === fichaId);
    if (!ficha) {
        showToast("No se encontró la ficha de origen");
        return;
    }
    const inputRef = document.getElementById("sol-ref");
    inputRef.value = ficha.referencia || "";
    // El lote/OP lo digita quien solicita el material: se deja en blanco.
    document.getElementById("sol-lote").value = "";
    document.getElementById("plt-solicitud-card").scrollIntoView({ behavior: "smooth", block: "center" });
    inputRef.focus();
    showToast(`Referencia ${ficha.referencia} cargada. Digita el lote/OP.`);
}

// =====================================================================
// AVANCE DE PRODUCCIÓN POR TALLA
// El reporte se guarda en f.avancesPorTalla; unidadesTerminadas sigue siendo
// el total (suma de tallas) para no romper los porcentajes existentes.
// =====================================================================
function obtenerAvancePorTalla(f) {
    return f && Array.isArray(f.avancesPorTalla) ? f.avancesPorTalla : [];
}

function totalAvance(f) {
    const lista = obtenerAvancePorTalla(f);
    if (lista.length) {
        return lista.reduce((suma, a) => suma + (parseInt(a.unidades, 10) || 0), 0);
    }
    return parseInt(f && f.unidadesTerminadas, 10) || 0;
}

function porcentajeAvance(f) {
    const meta = parseInt(f && f.cantidadPrendas, 10) || 0;
    if (meta <= 0) return 0;
    return Math.min(100, Math.round((totalAvance(f) / meta) * 100));
}

function addAvanceTallaRow(talla = "", unidades = "", fecha = "") {
    const tbody = document.getElementById("av-tallas-body");
    if (!tbody) return;
    const tr = document.createElement("tr");
    if (fecha) tr.dataset.fecha = fecha;
    tr.innerHTML = `
        <td class="p-2">
            <input type="text" list="av-tallas-list" value="${escapeHtml(talla)}" placeholder="Ej: M, 32, Única" class="av-talla w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-bold uppercase focus:ring-2 focus:ring-yellow-400 outline-none">
        </td>
        <td class="p-2">
            <input type="number" min="0" step="1" value="${unidades === "" ? "" : escapeHtml(String(unidades))}" placeholder="0" class="av-unidades-talla w-full rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs text-right focus:ring-2 focus:ring-yellow-400 outline-none">
        </td>
        <td class="p-2 text-center">
            <button type="button" onclick="removeAvanceTallaRow(this)" class="p-1.5 text-zinc-400 hover:text-rose-600 rounded-lg hover:bg-rose-50"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        </td>
    `;
    tbody.appendChild(tr);
    actualizarResumenAvance();
    renderIcons();
}

function removeAvanceTallaRow(btn) {
    const tbody = btn.closest("tbody");
    if (tbody.querySelectorAll("tr").length <= 1) {
        showToast("Deja al menos una talla en el reporte");
        return;
    }
    btn.closest("tr").remove();
    actualizarResumenAvance();
}

function onAvanceTallaInput(evento) {
    const tr = evento.target.closest("tr");
    if (tr) delete tr.dataset.fecha; // si cambia el valor, se marca la fecha nueva al guardar
    actualizarResumenAvance();
}

function leerAvanceTallas() {
    return Array.from(document.querySelectorAll("#av-tallas-body tr")).map(tr => ({
        talla: (tr.querySelector(".av-talla")?.value || "").trim().toUpperCase(),
        unidades: parseInt(tr.querySelector(".av-unidades-talla")?.value, 10) || 0,
        fecha: tr.dataset.fecha || ""
    })).filter(a => a.talla || a.unidades);
}

function actualizarResumenAvance() {
    const box = document.getElementById("av-resumen");
    if (!box) return;
    const f = appFichas.find(x => x.id === document.getElementById("av-ficha-id").value);
    if (!f) return;
    const total = leerAvanceTallas().reduce((suma, a) => suma + a.unidades, 0);
    const meta = parseInt(f.cantidadPrendas, 10) || 0;
    const pct = meta > 0 ? Math.min(100, Math.round((total / meta) * 100)) : 0;
    box.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div><span class="block text-[10px] font-bold uppercase text-zinc-500">Total reportado</span><strong class="text-lg text-zinc-950">${total}</strong> / ${meta} und</div>
            <div><span class="block text-[10px] font-bold uppercase text-zinc-500">Avance</span><strong class="text-lg ${pct === 100 ? "text-emerald-600" : "text-yellow-700"}">${pct}%</strong></div>
        </div>
        <div class="w-full h-2 bg-zinc-200 rounded-full overflow-hidden mt-2">
            <div class="h-full ${pct === 100 ? "bg-emerald-500" : "bg-yellow-400"}" style="width: ${pct}%"></div>
        </div>
    `;
}

function verDesgloseAvance(fichaId) {
    const f = appFichas.find(x => x.id === fichaId);
    if (!f) return;
    const lista = obtenerAvancePorTalla(f);
    const total = totalAvance(f);
    const meta = parseInt(f.cantidadPrendas, 10) || 0;
    const pct = porcentajeAvance(f);

    document.getElementById("av-detalle-title").textContent = `Avance por talla — ${f.referencia}`;
    document.getElementById("av-detalle-subtitle").textContent = [f.prenda, f.plantaNombre].filter(Boolean).join(" · ");
    document.getElementById("av-detalle-resumen").innerHTML = `
        <div class="p-3 rounded-xl bg-zinc-950 text-yellow-400">
            <div class="text-[10px] font-bold uppercase">Reportado</div>
            <div class="text-lg font-black">${total}</div>
        </div>
        <div class="p-3 rounded-xl bg-zinc-100 text-zinc-950">
            <div class="text-[10px] font-bold uppercase">Meta</div>
            <div class="text-lg font-black">${meta}</div>
        </div>
        <div class="p-3 rounded-xl ${pct === 100 ? "bg-emerald-50 text-emerald-700" : "bg-yellow-50 text-yellow-700"}">
            <div class="text-[10px] font-bold uppercase">Avance</div>
            <div class="text-lg font-black">${pct}%</div>
        </div>
    `;
    document.getElementById("av-detalle-body").innerHTML = lista.length
        ? lista.map(a => {
            const uni = parseInt(a.unidades, 10) || 0;
            const parte = total > 0 ? Math.round((uni / total) * 100) : 0;
            return `
                <tr>
                    <td class="py-2 px-3 font-extrabold text-zinc-950">${escapeHtml(a.talla)}</td>
                    <td class="py-2 px-3 text-right font-bold">${uni}</td>
                    <td class="py-2 px-3 text-right">${parte}%</td>
                    <td class="py-2 px-3 text-[11px] text-zinc-500">${escapeHtml(formatearFechaHora(a.fecha || f.fecha))}</td>
                </tr>
            `;
        }).join("")
        : `<tr><td colspan="4" class="py-8 text-center text-zinc-400">Aún no hay avance registrado por talla.</td></tr>`;

    const notaBox = document.getElementById("av-detalle-nota");
    if (f.notaAvance) {
        notaBox.textContent = `Nota: ${f.notaAvance}`;
        notaBox.classList.remove("hidden");
    } else {
        notaBox.classList.add("hidden");
    }

    const editBtn = document.getElementById("av-detalle-edit-btn");
    editBtn.dataset.fichaId = f.id;
    editBtn.classList.toggle("hidden", currentRole !== "planta" || !puedeHacer("avance"));
    document.getElementById("avance-detalle-modal").classList.remove("hidden");
    renderIcons();
}

function editarAvanceDesdeDetalle() {
    if (!requierePermiso("avance")) return;
    const id = document.getElementById("av-detalle-edit-btn").dataset.fichaId;
    if (!id) return;
    closeModal("avance-detalle-modal");
    openAvanceModal(id);
}

function openAvanceModal(fichaId) {
    if (!requierePermiso("avance")) return;
    const f = appFichas.find(item => item.id === fichaId);
    if (!f) return;
    document.getElementById("av-ficha-id").value = f.id;
    document.getElementById("av-ficha-info").innerHTML = `
        <div class="font-extrabold text-zinc-950">${f.referencia} — ${f.prenda}</div>
        <div class="text-zinc-500 mt-0.5">Planta: <strong>${f.plantaNombre || "—"}</strong> · Meta: <strong>${f.cantidadPrendas} unidades</strong></div>
    `;
    const tbody = document.getElementById("av-tallas-body");
    tbody.innerHTML = "";
    const tallas = obtenerAvancePorTalla(f);
    if (tallas.length) {
        tallas.forEach(a => addAvanceTallaRow(a.talla, a.unidades, a.fecha || ""));
    } else {
        // Fichas antiguas: se conserva el total y se pide especificar la talla.
        addAvanceTallaRow("", f.unidadesTerminadas || 0, "");
    }
    document.getElementById("av-nota").value = f.notaAvance || "";
    document.getElementById("av-error").classList.add("hidden");
    actualizarResumenAvance();
    document.getElementById("avance-modal").classList.remove("hidden");
    renderIcons();
}

function guardarAvanceProduccion(e) {
    e.preventDefault();
    if (!requierePermiso("avance")) return;
    const errorBox = document.getElementById("av-error");
    errorBox.classList.add("hidden");
    const id = document.getElementById("av-ficha-id").value;
    const f = appFichas.find(item => item.id === id);
    if (!f) return;

    const lista = [];
    for (const tr of Array.from(document.querySelectorAll("#av-tallas-body tr"))) {
        const talla = (tr.querySelector(".av-talla")?.value || "").trim().toUpperCase();
        const inputUni = tr.querySelector(".av-unidades-talla");
        const tieneUnidades = inputUni && inputUni.value !== "";
        const unidades = parseInt(inputUni?.value, 10);
        if (!talla && tieneUnidades) {
            errorBox.textContent = "Escribe la talla en cada fila que tenga unidades.";
            errorBox.classList.remove("hidden");
            return;
        }
        if (!talla) continue;
        lista.push({
            talla: talla,
            unidades: Number.isFinite(unidades) && unidades >= 0 ? unidades : 0,
            fecha: tr.dataset.fecha || new Date().toISOString()
        });
    }
    if (!lista.length) {
        errorBox.textContent = "Ingresa al menos una talla con unidades terminadas.";
        errorBox.classList.remove("hidden");
        return;
    }

    // Si repiten talla, se unifica sumando unidades.
    const resumen = new Map();
    lista.forEach(a => {
        const previo = resumen.get(a.talla);
        if (previo) {
            previo.unidades += a.unidades;
            previo.fecha = a.fecha;
        } else {
            resumen.set(a.talla, { ...a });
        }
    });

    f.avancesPorTalla = Array.from(resumen.values());
    f.unidadesTerminadas = f.avancesPorTalla.reduce((suma, a) => suma + a.unidades, 0);
    f.notaAvance = document.getElementById("av-nota").value.trim();
    saveAllState();
    renderPlantaView();
    renderCentralView();
    closeModal("avance-modal");
    showToast(`Avance actualizado: ${f.unidadesTerminadas} / ${f.cantidadPrendas} unidades · ${f.avancesPorTalla.length} talla(s)`);
}

// =====================================================================
// BANDEJA DE DESPACHOS
// =====================================================================
function setBodegaArea(area) {
    if (conAuth()) {
        const s = Auth.sesion();
        if (s && s.rol !== "ADMIN" && s.rol !== "LECTURA" && !Auth.puedeDespacharArea(area)) {
            showToast("Tu usuario solo puede ver el área asignada.");
            return;
        }
    }
    activeBodegaArea = area;
    ["ALL", "TELA", "INSUMO"].forEach(a => {
        const btn = document.getElementById(`bod-filter-${a}`);
        btn.classList.remove("bg-zinc-950", "bg-yellow-400", "text-yellow-400", "text-zinc-950", "shadow-sm");
        if (a === "ALL") btn.classList.add("bg-zinc-100", "text-zinc-700");
        if (a === "TELA") btn.classList.add("bg-yellow-50", "text-zinc-900");
        if (a === "INSUMO") btn.classList.add("bg-zinc-100", "text-zinc-800");

        if (a === area) {
            btn.classList.remove("bg-zinc-100", "text-zinc-700", "bg-yellow-50", "text-zinc-900", "text-zinc-800");
            if (a === "TELA") btn.classList.add("bg-yellow-400", "text-zinc-950", "shadow-sm");
            else btn.classList.add("bg-zinc-950", "text-yellow-400", "shadow-sm");
        }
    });
    renderBodegaView();
}

function renderBodegaView() {
    const banner = document.getElementById("bodega-responsable-banner");
    if (activeBodegaArea === "TELA") {
        banner.className = "p-4 rounded-2xl border border-yellow-400 bg-yellow-50 text-zinc-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3";
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="p-2.5 bg-yellow-400 text-zinc-950 rounded-xl"><i data-lucide="layers" class="w-5 h-5"></i></div>
                <div>
                    <span class="text-[11px] font-extrabold uppercase tracking-wider text-yellow-700">Filtro: Bodega de Telas</span>
                    <h3 class="font-extrabold text-sm">${appConfig.telaNombre}</h3>
                </div>
            </div>
            <span class="text-xs font-mono bg-white px-3 py-1.5 rounded-xl border border-yellow-300 font-bold">${appConfig.telaEmail}</span>
        `;
    } else if (activeBodegaArea === "INSUMO") {
        banner.className = "p-4 rounded-2xl border border-zinc-300 bg-zinc-100 text-zinc-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3";
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="p-2.5 bg-zinc-950 text-yellow-400 rounded-xl"><i data-lucide="component" class="w-5 h-5"></i></div>
                <div>
                    <span class="text-[11px] font-extrabold uppercase tracking-wider text-zinc-600">Filtro: Almacén de Insumos</span>
                    <h3 class="font-extrabold text-sm">${appConfig.insumoNombre}</h3>
                </div>
            </div>
            <span class="text-xs font-mono bg-white px-3 py-1.5 rounded-xl border border-zinc-300 font-bold">${appConfig.insumoEmail}</span>
        `;
    } else {
        banner.className = "p-4 rounded-2xl border border-zinc-200 bg-white text-zinc-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3";
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="p-2.5 bg-zinc-950 text-yellow-400 rounded-xl"><i data-lucide="warehouse" class="w-5 h-5"></i></div>
                <div>
                    <span class="text-[11px] font-bold uppercase tracking-wider text-zinc-500">Vista Consolidada</span>
                    <h3 class="font-extrabold text-sm">Solicitudes dirigidas a Telas e Insumos</h3>
                </div>
            </div>
            <span class="text-xs font-semibold text-zinc-500">Crearte By Confeccionarte SAS</span>
        `;
    }

    const statusFilter = document.getElementById("bod-status-filter").value;
    const filtered = appSolicitudes.filter(s => {
        const matchArea = activeBodegaArea === "ALL" || s.area === activeBodegaArea;
        const matchStatus = statusFilter === "ALL" || s.estado === statusFilter;
        return matchArea && matchStatus;
    });

    const tbody = document.getElementById("bodega-tbody");
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-zinc-400 text-xs">No hay solicitudes con el filtro seleccionado.</td></tr>`;
        renderIcons();
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const urgClass = s.urgencia === "Crítica" ? "bg-rose-100 text-rose-800" : (s.urgencia === "Alta" ? "bg-yellow-200 text-zinc-950" : "bg-zinc-100 text-zinc-700");
        const areaBadge = s.area === "TELA"
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-extrabold bg-yellow-100 text-zinc-950 border border-yellow-300"><i data-lucide="layers" class="w-3 h-3 text-yellow-700"></i> Telas</span>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-zinc-200 text-zinc-900"><i data-lucide="component" class="w-3 h-3"></i> Insumos</span>`;

        const puedeDespacharEsta = puedeHacer("despachar") && (!conAuth() || Auth.puedeDespacharArea(s.area));
        const actionBtn = s.estado === "Pendiente" && puedeDespacharEsta
            ? `<button type="button" onclick="openDispatchModal('${s.id}')" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-extrabold bg-yellow-400 text-zinc-950 hover:bg-yellow-500 shadow-sm">
                   <i data-lucide="truck" class="w-3.5 h-3.5"></i> Despachar
               </button>`
            : `<button type="button" onclick="viewSolicitudDetail('${s.id}')" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-zinc-950 text-yellow-400 hover:bg-zinc-800">
                   <i data-lucide="printer" class="w-3.5 h-3.5"></i> ${s.despachoInfo?.remision || (s.estado === "Pendiente" ? "Ver solicitud" : "Remisión")}
               </button>`;

        return `
            <tr class="hover:bg-zinc-50 transition-colors">
                <td class="py-3.5 px-4">
                    <div class="font-extrabold text-xs text-zinc-950">${s.id}</div>
                    <span class="inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${urgClass}">${s.urgencia}</span>
                </td>
                <td class="py-3.5 px-4">
                    <div class="font-extrabold text-xs text-zinc-950">${s.plantaNombre}</div>
                    <div class="text-[11px] text-zinc-400">${s.fecha}</div>
                </td>
                <td class="py-3.5 px-4">${areaBadge}</td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-xs text-zinc-900">${s.referencia} (${s.lote})</div>
                    <div class="text-[11px] ${s.fueraDePlazo ? "font-bold text-rose-700" : "text-zinc-500"}">${s.motivo}${s.fueraDePlazo ? " · Fuera del plazo de dos días" : ""}</div>
                </td>
                <td class="py-3.5 px-4 text-xs text-zinc-700">
                    ${(s.items || []).map(i => `<div>• ${i.desc} (${i.color}): <strong>${i.cant} ${i.unidad}</strong></div>`).join("")}
                </td>
                <td class="py-3.5 px-4">
                    ${s.estado === "Pendiente"
                        ? `<span class="px-2.5 py-1 rounded-full text-xs font-extrabold bg-yellow-200 text-zinc-950">Pendiente</span>`
                        : `<div class="space-y-1">
                            <span class="inline-block px-2.5 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800">Despachado</span>
                            ${s.firmaRecibido
                                ? `<div class="text-[10px] font-bold text-emerald-700"><i data-lucide="check-circle" class="w-3 h-3 inline"></i> Firmado por ${escapeHtml(s.firmaRecibido.nombre || "la planta")}</div>`
                                : `<div class="text-[10px] font-semibold text-amber-700">Firma de recibido pendiente</div>`}
                        </div>`}
                </td>
                <td class="py-3.5 px-4 text-right">${actionBtn}</td>
            </tr>
        `;
    }).join("");

    renderIcons();
}

function openDispatchModal(solId) {
    const sol = appSolicitudes.find(s => s.id === solId);
    if (!sol) return;
    if (!requierePermiso("despachar", sol.area)) return;

    document.getElementById("disp-sol-id").value = sol.id;
    document.getElementById("disp-modal-title").textContent = `Despachar ${sol.id} (${sol.area === "TELA" ? "Telas" : "Insumos"})`;

    document.getElementById("disp-info-box").innerHTML = `
        <div><span class="text-zinc-400 block">Planta Destino:</span><strong class="text-zinc-950">${sol.plantaNombre}</strong></div>
        <div><span class="text-zinc-400 block">Referencia / Lote:</span><strong class="text-zinc-950">${sol.referencia} (${sol.lote})</strong></div>
        <div><span class="text-zinc-400 block">Motivo:</span><strong class="text-zinc-800">${sol.motivo}</strong></div>
        <div><span class="text-zinc-400 block">Urgencia:</span><strong class="text-rose-700">${sol.urgencia}</strong></div>
        ${sol.fueraDePlazo ? `<div class="sm:col-span-2 p-2 rounded-lg bg-rose-100 text-rose-800 font-bold">Solicitud realizada después de los dos días hábiles. Si autorizas el despacho, se avisará a Contabilidad para el cobro.</div>` : ""}
    `;

    const cobroBox = document.getElementById("disp-cobro-box");
    const autorizaCobro = document.getElementById("disp-autoriza-cobro");
    autorizaCobro.checked = false;
    cobroBox.classList.toggle("hidden", !sol.fueraDePlazo);

    document.getElementById("disp-items-tbody").innerHTML = (sol.items || []).map((it, idx) => `
        <tr>
            <td class="py-2.5 px-3 font-bold text-zinc-900">${it.desc}</td>
            <td class="py-2.5 px-3 text-zinc-500">${it.color}</td>
            <td class="py-2.5 px-3 text-center font-medium">${it.cant} ${it.unidad}</td>
            <td class="py-2.5 px-3 text-right">
                <input type="number" step="0.01" min="0" required value="${it.cant}" data-idx="${idx}" class="disp-qty-input w-24 rounded-lg border border-zinc-300 px-2 py-1 text-right font-extrabold text-zinc-950 focus:ring-2 focus:ring-yellow-400 outline-none">
            </td>
        </tr>
    `).join("");

    const prefix = sol.area === "TELA" ? "REM-TEL-" : "REM-INS-";
    document.getElementById("disp-remision").value = `${prefix}${Math.floor(10000 + Math.random() * 89999)}`;
    document.getElementById("disp-transporte").value = "";
    document.getElementById("disp-notas").value = "";

    document.getElementById("dispatch-modal").classList.remove("hidden");
    renderIcons();
}

async function confirmDispatch(e) {
    e.preventDefault();
    const solId = document.getElementById("disp-sol-id").value;
    const sol = appSolicitudes.find(s => s.id === solId);
    if (!sol) return;
    if (!requierePermiso("despachar", sol.area)) return;

    const remision = document.getElementById("disp-remision").value.trim();
    const transporte = document.getElementById("disp-transporte").value.trim();
    const notas = document.getElementById("disp-notas").value.trim();
    const autorizaCobro = !!document.getElementById("disp-autoriza-cobro")?.checked;

    document.querySelectorAll(".disp-qty-input").forEach(inp => {
        const idx = parseInt(inp.dataset.idx);
        sol.items[idx].cantDespachada = parseFloat(inp.value) || 0;
    });

    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    if (!sol.firmaToken) sol.firmaToken = generarTokenFirma();
    sol.firmaUrl = construirUrlFirmaSolicitud(sol.id, sol.firmaToken);
    sol.firmaEmailEnviado = false;

    const plantaDespacho = appPlantas.find(p => p.id === sol.plantaId);
    const responsableDespacho = sol.area === "TELA" ? appConfig.telaNombre : appConfig.insumoNombre;

    sol.estado = "Despachado";
    sol.despachoInfo = {
        fecha: now,
        remision: remision,
        transporte: transporte,
        notas: notas,
        responsable: responsableDespacho || appConfig.despachadorNombre || "Despachador",
        fueraDePlazo: !!sol.fueraDePlazo,
        cobroAutorizado: !!(sol.fueraDePlazo && autorizaCobro),
        cobroCorreoEnviado: false
    };

    saveAllState();
    renderCentralView();
    closeModal("dispatch-modal");

    const planta = appPlantas.find(p => p.id === sol.plantaId);
    const responsable = sol.area === "TELA" ? appConfig.telaNombre : appConfig.insumoNombre;
    const areaEmail = sol.area === "TELA" ? appConfig.telaEmail : appConfig.insumoEmail;
    const areaNombre = sol.area === "TELA" ? "Bodega de Telas" : "Almacén de Insumos";
    const materiales = (sol.items || []).map((it, idx) =>
        `  ${idx + 1}. ${it.desc} | ${it.color || "—"} | ${it.cantDespachada ?? it.cant} ${it.unidad}`
    ).join("\n");

    // 1) Correo a la planta para que firme que recibió este despacho.
    const firmaPayload = {
        tipoEvento: "DESPACHO_MATERIAL_FIRMA",
        para: planta?.email || sol.emailPlanta || "",
        cc: [appConfig.ingEmail, areaEmail].filter(Boolean).join(", "),
        asunto: `[FIRMAR RECIBIDO] ${sol.id} | ${planta?.nombre || sol.plantaNombre} | Remisión ${remision}`,
        cuerpo: `Estimados ${planta?.nombre || sol.plantaNombre} (${planta?.contacto || "planta"}),\n\n` +
            lineaUrlPlataforma() +
            `\n` +
            `${areaNombre} despachó el material que solicitaste. Confirma que lo recibiste firmando electrónicamente y marcando el estado de cada material.\n\n` +
            `SOLICITUD: ${sol.id}\n` +
            `REMISIÓN / GUÍA: ${remision}\n` +
            `REFERENCIA / LOTE: ${sol.referencia} / ${sol.lote}\n` +
            `MOTIVO: ${sol.motivo}\n` +
            `FECHA DESPACHO: ${now}\n` +
            (transporte ? `TRANSPORTE / MENSAJERO: ${transporte}\n` : "") +
            `\nMATERIALES DESPACHADOS:\n${materiales}\n\n` +
            (notas ? `OBSERVACIONES DEL DESPACHO:\n${notas}\n\n` : "") +
            `ENLACE PARA FIRMAR ELECTRÓNICAMENTE EL RECIBIDO (Recibido y Estado por material):\n${sol.firmaUrl || "Enlace disponible cuando el sitio esté publicado."}\n\n` +
            `Al firmar confirmas que recibiste los materiales de esta remisión. Si hay novedades, indícalas en la observación de cada ítem.\n\n` +
            `Atentamente,\n${APP_SYSTEM.nombreApp} - ${APP_SYSTEM.empresa}`,
        adjuntoPdf: null,
        // El Apps Script usa estos campos para dibujar el botón "Firmar recibido".
        firmaUrl: sol.firmaUrl,
        firmaToken: sol.firmaToken,
        solicitudId: sol.id
    };

    let firmaOk = false;
    try {
        if (firmaPayload.para) {
            const resultadoFirma = await DataStore.enviarCorreoConPdf(firmaPayload);
            firmaOk = resultadoFirma?.ok !== false;
            sol.firmaEmailEnviado = firmaOk;
            sol.firmaEmailFecha = new Date().toISOString();
            sol.firmaEmailPara = firmaPayload.para;
            saveAllState();
            renderCentralView();
            DataStore.notificarPanelCentral("DESPACHO_MATERIAL_FIRMA", {
                solicitudId: sol.id,
                remision,
                planta: sol.plantaNombre,
                para: firmaPayload.para,
                firmaUrl: sol.firmaUrl
            });
        } else {
            console.warn("La planta no tiene correo configurado; no se envió el enlace de firma.", sol.plantaNombre);
        }
    } catch (err) {
        console.error("Error enviando enlace de firma a la planta:", err);
    }

    if (!sol.fueraDePlazo || !autorizaCobro) {
        showToast(`Solicitud ${sol.id} despachada (Guía ${remision})${firmaOk ? ". Enlace de firma enviado a la planta." : ". No se pudo enviar el enlace de firma."}`);
        return;
    }

    // 2) Correo a Contabilidad cuando el despacho autoriza el cobro.
    const cobroPayload = {
        tipoEvento: "COBRO_CONTABILIDAD",
        para: appConfig.contabilidadEmail || "",
        cc: appConfig.ingEmail,
        asunto: `[COBRO MATERIAL FUERA DE PLAZO] ${sol.id} | ${planta?.nombre || sol.plantaNombre} | Ref: ${sol.referencia}`,
        cuerpo: `Se autoriza el cobro del material despachado fuera del plazo de dos días hábiles.\n\n` +
            `SOLICITUD: ${sol.id}\n` +
            `FECHA SOLICITUD: ${sol.fecha}\n` +
            `PLANTA: ${planta?.nombre || sol.plantaNombre}\n` +
            `REFERENCIA / LOTE: ${sol.referencia} / ${sol.lote}\n` +
            `MOTIVO: ${sol.motivo}\n` +
            `ÁREA: ${areaNombre}\n` +
            `AUTORIZADO POR: ${responsable || appConfig.despachadorNombre || "Despachador"}\n` +
            `REMISIÓN / GUÍA: ${remision}\n` +
            `FECHA DESPACHO: ${now}\n\n` +
            `MATERIALES DESPACHADOS:\n${materiales}\n\n` +
            (notas ? `OBSERVACIONES DEL DESPACHO:\n${notas}\n\n` : "") +
            `Por favor realizar el cobro correspondiente.\n\nAtentamente,\n${APP_SYSTEM.nombreApp} - ${APP_SYSTEM.empresa}`,
        adjuntoPdf: null
    };

    try {
        const resultado = await DataStore.enviarCorreoConPdf(cobroPayload);
        const enviado = resultado?.ok !== false;
        sol.despachoInfo.cobroCorreoEnviado = enviado;
        sol.despachoInfo.cobroFecha = new Date().toISOString();
        sol.despachoInfo.cobroPara = cobroPayload.para;
        saveAllState();
        renderCentralView();
        DataStore.notificarPanelCentral("COBRO_CONTABILIDAD", {
            solicitudId: sol.id,
            remision,
            referencia: sol.referencia,
            lote: sol.lote,
            planta: sol.plantaNombre,
            area: sol.area,
            para: cobroPayload.para,
            autorizadoPor: responsable
        });
        showToast(enviado
            ? `Solicitud ${sol.id} despachada. Firma enviada a la planta y aviso de cobro a Contabilidad.`
            : `Solicitud ${sol.id} despachada, pero el correo a Contabilidad falló.`);
    } catch (err) {
        console.error("Error enviando aviso de cobro a Contabilidad:", err);
        showToast(`Solicitud ${sol.id} despachada, pero el correo a Contabilidad falló.`);
    }
}

// =====================================================================
// MODALES DE CORREO Y REMISIÓN OFICIAL IMPRIMIBLE (PDF)
// =====================================================================
function openEmailModal(to, cc, subject, body, attachment, isSplit, permiso) {
    pendingCommitPermiso = permiso || null;
    document.getElementById("prev-to").textContent = to;
    document.getElementById("prev-cc").textContent = cc;
    document.getElementById("prev-subject").textContent = subject;
    document.getElementById("prev-body").textContent = body;

    const splitAlert = document.getElementById("email-split-alert");
    if (isSplit) splitAlert.classList.remove("hidden");
    else splitAlert.classList.add("hidden");

    const attRow = document.getElementById("prev-attachment-row");
    const attachments = (Array.isArray(attachment) ? attachment : [attachment]).filter(Boolean);
    const attContainer = document.getElementById("prev-attachment");
    attContainer.textContent = "";

    if (attachments.length) {
        attRow.classList.remove("hidden");
        attachments.forEach((nombre, index) => {
            if (index > 0) attContainer.appendChild(document.createTextNode("  •  "));
            const chip = document.createElement("span");
            chip.className = "inline-flex items-center gap-1";
            const icon = document.createElement("i");
            icon.setAttribute("data-lucide", "paperclip");
            icon.className = "w-3 h-3";
            chip.appendChild(icon);
            chip.appendChild(document.createTextNode(nombre));
            attContainer.appendChild(chip);
        });
        renderIcons();
    } else {
        attRow.classList.add("hidden");
    }

    // Los destinatarios deben codificarse uno por uno: codificar la lista completa
    // (incluidas las comas) hace que muchos clientes de correo no la reconozcan.
    const encodeAddresses = value => String(value || "")
        .split(",")
        .map(addr => encodeURIComponent(addr.trim()))
        .filter(Boolean)
        .join(",");
    const ccParam = cc ? `cc=${encodeAddresses(cc)}&` : "";
    currentMailtoUrl = `mailto:${encodeAddresses(to)}?${ccParam}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    document.getElementById("email-modal").classList.remove("hidden");
    renderIcons();
}

function openMailClient() {
    commitPendingAction(false);
    window.open(currentMailtoUrl, "_blank");
}

async function commitPendingAction(shouldClose) {
    if (!pendingCommitCallback) {
        if (shouldClose) closeModal("email-modal");
        return;
    }
    if (!requierePermiso(pendingCommitPermiso || "fichas")) {
        if (shouldClose) closeModal("email-modal");
        return;
    }
    try {
        await pendingCommitCallback();
    } catch (err) {
        console.error("Error al confirmar la acción pendiente:", err);
        showToast("La acción se registró, pero hubo un error al procesar el correo");
    } finally {
        pendingCommitCallback = null;
        pendingEmailPayload = null;
        pendingCommitPermiso = null;
        if (shouldClose) closeModal("email-modal");
    }
}

function copyEmailContent() {
    const subject = document.getElementById("prev-subject").textContent;
    const body = document.getElementById("prev-body").textContent;
    const fullText = `Asunto: ${subject}\n\n${body}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(fullText).then(() => showToast("Texto copiado"));
    } else {
        const temp = document.createElement("textarea");
        temp.value = fullText;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        document.body.removeChild(temp);
        showToast("Texto copiado");
    }
}

function buildHeaderRemisionHTML(docTitulo, docCodigo, fecha) {
    return `
        <div class="flex items-center justify-between border-b-2 border-zinc-950 pb-4 mb-4">
            <div class="flex items-center gap-3">
                <img src="img/logo.png" alt="Crearte" class="h-11 w-auto object-contain" onerror="this.style.display='none'">
                <div>
                    <div class="font-black text-base text-zinc-950 uppercase tracking-tight">Crearte By Confeccionarte SAS</div>
                    <div class="text-xs font-bold text-zinc-600">NIT. 901.367.620-0 • Área de Producción</div>
                </div>
            </div>
            <div class="text-right">
                <div class="inline-block px-3 py-1 bg-yellow-400 text-zinc-950 font-black text-xs rounded-lg uppercase">${docTitulo}</div>
                <div class="font-mono font-extrabold text-sm text-zinc-950 mt-1">${docCodigo}</div>
                <div class="text-[11px] text-zinc-500">${fecha}</div>
            </div>
        </div>
    `;
}

function buildFirmasRemisionHTML(ficha) {
    const esSolicitud = !!(ficha && ficha.area && ficha.despachoInfo);
    const firma = ficha
        ? (esSolicitud ? appFirmasDespachos[ficha.id] : appFirmas[ficha.id])
        : null;
    const firmaSrc = firma && /^data:image\//.test(firma.firmaDataUrl || "") ? firma.firmaDataUrl : "";
    const despachador = esSolicitud
        ? (ficha.despachoInfo.responsable ||
            (ficha.area === "TELA" ? appConfig.telaNombre : appConfig.insumoNombre) ||
            appConfig.despachadorNombre || "Despachador")
        : (appConfig.despachadorNombre || appConfig.telaNombre || "Despachador");
    const fechaDespacho = ficha
        ? formatearFechaHora(ficha.despachoInfo?.fecha || ficha.fecha)
        : formatearFechaHora(new Date().toISOString());

    return `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-8 mt-6 border-t border-zinc-200 text-xs">
            <div class="text-left">
                <div class="h-16 flex items-end">
                    <span style="font-family: 'Segoe Script', 'Brush Script MT', cursive; font-size: 1.7rem; line-height: 1.1;">${escapeHtml(despachador)}</span>
                </div>
                <div class="border-t border-zinc-800 pt-1.5 font-bold text-zinc-900">Despachado por</div>
                <div class="font-semibold text-zinc-800">${escapeHtml(despachador)}</div>
                <div class="text-[11px] text-zinc-500">${escapeHtml(APP_SYSTEM.empresa)}</div>
                <div class="text-[11px] text-zinc-500">Fecha: ${escapeHtml(fechaDespacho)}</div>
            </div>
            <div class="text-left">
                ${firmaSrc ? `
                    <img src="${firmaSrc}" alt="Firma de recibido" class="h-16 max-w-full object-contain">
                    <div class="border-t border-zinc-800 pt-1.5 font-bold text-zinc-900">Recibe conforme — Planta Externa</div>
                    <div class="font-semibold text-zinc-800">${escapeHtml(firma.nombre || "Firmante")}</div>
                    <div class="text-[11px] text-zinc-500">C.C. ${escapeHtml(firma.cedula || "—")}</div>
                    <div class="text-[11px] text-zinc-500">Firmado: ${escapeHtml(formatearFechaHora(firma.fecha))}</div>
                ` : `
                    <div class="h-16 flex items-center justify-center border border-dashed border-zinc-300 rounded-lg text-[11px] text-zinc-400">
                        Firma electrónica pendiente
                    </div>
                    <div class="border-t border-zinc-800 pt-1.5 font-bold text-zinc-900">Recibe conforme — Planta Externa</div>
                    <div class="text-[11px] text-zinc-500">La planta debe firmar desde el enlace enviado al correo.</div>
                `}
            </div>
        </div>
    `;
}

function generarEnlaceFirma(id) {
    if (!requierePermiso("fichas")) return;
    const f = appFichas.find(item => item.id === id);
    if (!f) return;
    if (!f.firmaToken) f.firmaToken = generarTokenFirma();
    f.firmaUrl = construirUrlFirma(f.id, f.firmaToken);
    if (!f.fechaLimiteNovedades) f.fechaLimiteNovedades = calcularFechaLimiteNovedades(f.fecha);
    saveAllState();
    viewFichaDetail(id);
    showToast("Enlace de firma generado");
}

function viewFichaDetail(id) {
    aplicarItemsConfirmadosAFichas();
    const f = appFichas.find(item => item.id === id);
    if (!f) return;

    document.getElementById("det-title").textContent = `Remisión Inicial: ${f.id}`;
    document.getElementById("det-content").innerHTML = `
        ${buildHeaderRemisionHTML("Remisión Salida Inicial", f.id, f.fecha)}
        <div class="grid grid-cols-2 gap-3 bg-zinc-50 p-4 rounded-xl border border-zinc-200 text-xs mb-4">
            <div><span class="text-zinc-500 block">Planta Asignada:</span><strong class="text-zinc-950">${f.plantaNombre}</strong></div>
            <div><span class="text-zinc-500 block">Referencia / Lote:</span><strong class="text-zinc-950">${f.referencia} (${f.cantidadPrendas} und)</strong></div>
            <div><span class="text-zinc-500 block">Prenda / Estilo:</span><strong class="text-zinc-950">${f.prenda} (${f.cliente})</strong></div>
            <div><span class="text-zinc-500 block">Avance Reportado:</span><strong class="text-zinc-950">${totalAvance(f)} / ${f.cantidadPrendas} und (${porcentajeAvance(f)}%)</strong></div>
            <div class="col-span-2"><span class="text-zinc-500 block">Archivo Ficha Técnica:</span><span class="font-bold text-zinc-950">${f.archivoFicha}</span></div>
            ${f.archivoInsumos ? `<div class="col-span-2"><span class="text-zinc-500 block">Archivo Salida de Insumos:</span><span class="font-bold text-zinc-950">${f.archivoInsumos}</span></div>` : ""}
        </div>

        ${obtenerAvancePorTalla(f).length ? `
        <div class="mb-4">
            <h4 class="text-xs font-extrabold uppercase text-zinc-700 mb-2">Avance reportado por talla</h4>
            <div class="border border-zinc-300 rounded-xl overflow-x-auto">
                <table class="w-full min-w-[360px] text-left border-collapse text-xs">
                    <thead class="bg-zinc-100 text-zinc-700">
                        <tr>
                            <th class="py-2 px-3">Talla</th>
                            <th class="py-2 px-3 text-right">Unidades</th>
                            <th class="py-2 px-3">Último reporte</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-zinc-200">
                        ${obtenerAvancePorTalla(f).map(a => `
                            <tr>
                                <td class="py-2 px-3 font-extrabold text-zinc-950">${escapeHtml(a.talla)}</td>
                                <td class="py-2 px-3 text-right font-bold">${parseInt(a.unidades, 10) || 0}</td>
                                <td class="py-2 px-3 text-zinc-500">${escapeHtml(formatearFechaHora(a.fecha || f.fecha))}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
            ${f.notaAvance ? `<p class="mt-2 text-xs text-zinc-600"><strong>Nota de avance:</strong> ${escapeHtml(f.notaAvance)}</p>` : ""}
        </div>
        ` : ""}

        <div class="mb-4">
            <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                <h4 class="text-xs font-extrabold uppercase text-zinc-700">Materiales Entregados en Salida Inicial</h4>
                ${f.itemsConfirmadosAt
                    ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-extrabold">
                            <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> Recibido y estado confirmados por la planta: ${escapeHtml(formatearFechaHora(f.itemsConfirmadosAt))}
                        </span>`
                    : `<span class="text-[11px] font-semibold text-amber-700">Pendiente de confirmación de la planta</span>`}
            </div>
            <div class="border border-zinc-300 rounded-xl overflow-x-auto">
                <table class="w-full min-w-[720px] text-left border-collapse text-xs">
                    <thead class="bg-zinc-900 text-yellow-400">
                        <tr>
                            <th class="py-2 px-3">Material entregado</th>
                            <th class="py-2 px-3 text-right">Cantidad</th>
                            <th class="py-2 px-3">Unidad</th>
                            <th class="py-2 px-3">Recibido (Sí/No)</th>
                            <th class="py-2 px-3">Estado</th>
                            <th class="py-2 px-3">Observación</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-zinc-200">
                        ${(f.items || []).map(it => {
                            const material = it.material || it.desc || "—";
                            const observacion = [
                                it.observacion || (it.color ? `Color/Lote: ${it.color}` : ""),
                                it.observacionPlanta ? `Planta: ${it.observacionPlanta}` : ""
                            ].filter(Boolean).join(" · ");
                            const recibidoClase = it.recibido === "No" ? "text-rose-700" : it.recibido === "Sí" ? "text-emerald-700" : "text-zinc-900";
                            return `
                                <tr>
                                    <td class="py-2 px-3 font-extrabold text-zinc-900">${escapeHtml(material)}${it.confirmadoPorPlanta ? `<div class="text-[10px] font-semibold text-emerald-700">Confirmado por planta</div>` : ""}</td>
                                    <td class="py-2 px-3 text-right font-extrabold">${escapeHtml(it.cant ?? "—")}</td>
                                    <td class="py-2 px-3">${escapeHtml(it.unidad || "—")}</td>
                                    <td class="py-2 px-3 font-bold ${recibidoClase}">${escapeHtml(it.recibido || "—")}</td>
                                    <td class="py-2 px-3">${escapeHtml(it.estado || "—")}</td>
                                    <td class="py-2 px-3 text-zinc-600">${escapeHtml(observacion || "—")}</td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        </div>
        <div class="p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-zinc-800 mb-4">
            <strong>Plazo para reportar novedades:</strong> la planta receptora tiene <strong>dos días hábiles</strong> desde la recepción para reportar novedades.
            Fecha límite: <strong>${escapeHtml(formatearFechaHora(f.fechaLimiteNovedades || calcularFechaLimiteNovedades(f.fecha)))}</strong>.
            Pasado ese plazo se entiende recibido conforme.
        </div>
        ${f.notas ? `<div class="p-3 rounded-xl bg-yellow-50 border border-yellow-300 text-xs"><strong>Especificaciones:</strong> ${escapeHtml(f.notas)}</div>` : ""}
        ${!appFirmas[f.id] ? `
            <div class="mt-3 no-print">
                ${f.firmaUrl && plantaAutorizadaParaFirmar(f)
                    ? `<a href="${escapeHtml(f.firmaUrl)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-zinc-950 text-yellow-400 hover:bg-zinc-800"><i data-lucide="pen-line" class="w-3.5 h-3.5"></i> Abrir enlace de firma</a>`
                    : f.firmaUrl
                        ? `<span class="text-[11px] font-semibold text-amber-700">Pendiente de firma por ${escapeHtml(nombrePlantaRegistro(f))}</span>`
                        : (puedeHacer("fichas")
                            ? `<button type="button" onclick="generarEnlaceFirma('${f.id}')" class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-zinc-950 text-yellow-400 hover:bg-zinc-800"><i data-lucide="link" class="w-3.5 h-3.5"></i> Generar enlace de firma</button>`
                            : `<span class="text-[11px] font-semibold text-zinc-500">Enlace de firma pendiente</span>`)}
            </div>
        ` : ""}
        ${buildFirmasRemisionHTML(f)}
    `;
    document.getElementById("detail-modal").classList.remove("hidden");
    renderIcons();
}

function viewSolicitudDetail(id) {
    aplicarFirmasDespachosASolicitudes();
    const s = appSolicitudes.find(item => item.id === id);
    if (!s) return;

    const codigoDoc = s.despachoInfo?.remision ? `${s.despachoInfo.remision} (${s.id})` : s.id;
    document.getElementById("det-title").textContent = `Remisión de Solicitud: ${s.id}`;
    document.getElementById("det-content").innerHTML = `
        ${buildHeaderRemisionHTML(s.estado === "Despachado" ? "Remisión de Despacho" : "Solicitud de Material", codigoDoc, s.despachoInfo?.fecha || s.fecha)}
        <div class="grid grid-cols-2 gap-3 bg-zinc-50 p-4 rounded-xl border border-zinc-200 text-xs mb-4">
            <div><span class="text-zinc-500 block">Planta Solicitante:</span><strong class="text-zinc-950">${s.plantaNombre}</strong></div>
            <div><span class="text-zinc-500 block">Bodega Responsable:</span><strong class="text-zinc-950">${s.area === "TELA" ? "Bodega de Telas" : "Almacén de Insumos"}</strong></div>
            <div><span class="text-zinc-500 block">Referencia / Lote:</span><strong class="text-zinc-950">${s.referencia} (${s.lote})</strong></div>
            <div><span class="text-zinc-500 block">Motivo / Estado:</span><strong class="text-zinc-950">${s.motivo} — ${s.estado}</strong></div>
        </div>

        <div class="mb-4">
            <h4 class="text-xs font-extrabold uppercase text-zinc-700 mb-2">Detalle de Materiales</h4>
            <div class="border border-zinc-300 rounded-xl overflow-hidden">
                <table class="w-full text-left border-collapse text-xs">
                    <thead class="bg-zinc-900 text-yellow-400">
                        <tr><th class="py-2 px-3">Material</th><th class="py-2 px-3">Color</th><th class="py-2 px-3 text-right">Solicitado</th><th class="py-2 px-3 text-right">Despachado</th></tr>
                    </thead>
                    <tbody class="divide-y divide-zinc-200">
                        ${(s.items || []).map(it => `
                            <tr>
                                <td class="py-2 px-3 font-bold">${it.desc}</td>
                                <td class="py-2 px-3 text-zinc-600">${it.color}</td>
                                <td class="py-2 px-3 text-right">${it.cant} ${it.unidad}</td>
                                <td class="py-2 px-3 text-right font-extrabold text-zinc-950">${s.estado === "Despachado" ? `${it.cantDespachada} ${it.unidad}` : "Pendiente"}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </div>

        ${s.despachoInfo ? `
            <div class="p-3.5 rounded-xl bg-yellow-50 border border-yellow-300 text-xs space-y-1 text-zinc-950">
                <div class="font-extrabold">Datos de Entrega Confirmada</div>
                <div><strong>N° Remisión / Guía:</strong> <span class="font-mono">${s.despachoInfo.remision}</span></div>
                <div><strong>Transporte / Mensajero:</strong> ${s.despachoInfo.transporte}</div>
                ${s.despachoInfo.notas ? `<div><strong>Observaciones:</strong> ${s.despachoInfo.notas}</div>` : ""}
            </div>
        ` : ""}
        ${s.firmaRecibido ? `
            <div class="p-3.5 rounded-xl bg-emerald-50 border border-emerald-300 text-xs text-emerald-900 mb-4">
                <div class="flex items-center gap-2 font-extrabold text-sm">
                    <i data-lucide="check-circle" class="w-4 h-4"></i> Recibido firmado por la planta
                </div>
                <div class="mt-1"><strong>${escapeHtml(s.firmaRecibido.nombre || "Firmante")}</strong>${s.firmaRecibido.cedula ? ` · C.C. ${escapeHtml(s.firmaRecibido.cedula)}` : ""}${s.firmaRecibido.cargo ? ` · ${escapeHtml(s.firmaRecibido.cargo)}` : ""}</div>
                <div>Fecha: ${escapeHtml(formatearFechaHora(s.firmaRecibido.fecha))}</div>
                ${(s.firmaRecibido.items || []).length ? `
                    <div class="mt-2 overflow-x-auto border border-emerald-200 rounded-lg bg-white">
                        <table class="w-full text-left border-collapse text-[11px]">
                            <thead class="bg-emerald-100 text-emerald-900 font-extrabold">
                                <tr><th class="py-1.5 px-2">Material</th><th class="py-1.5 px-2">Recibido</th><th class="py-1.5 px-2">Estado</th><th class="py-1.5 px-2">Observación</th></tr>
                            </thead>
                            <tbody class="divide-y divide-emerald-100">
                                ${s.firmaRecibido.items.map(it => `
                                    <tr>
                                        <td class="py-1.5 px-2 font-bold">${escapeHtml(it.material || "")}</td>
                                        <td class="py-1.5 px-2">${escapeHtml(it.recibido || "—")}</td>
                                        <td class="py-1.5 px-2">${escapeHtml(it.estado || "—")}</td>
                                        <td class="py-1.5 px-2 text-zinc-600">${escapeHtml(it.observacion || "—")}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                ` : ""}
            </div>
        ` : s.firmaUrl ? `
            <div class="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs mb-4">
                <div class="font-extrabold">Firma de recibido pendiente</div>
                <div class="mt-1">Se envió el enlace a <strong>${escapeHtml(s.firmaEmailPara || s.plantaNombre)}</strong>. La planta debe confirmar Recibido (Sí/No) y Estado de cada material.</div>
                ${plantaAutorizadaParaFirmar(s)
                    ? `<a href="${escapeHtml(s.firmaUrl)}" target="_blank" rel="noopener" class="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-extrabold bg-zinc-950 text-yellow-400"><i data-lucide="pen-line" class="w-3.5 h-3.5"></i> Abrir enlace de firma</a>`
                    : `<div class="mt-2 text-[11px] font-semibold text-amber-700">Pendiente de firma por ${escapeHtml(nombrePlantaRegistro(s))}</div>`}
            </div>
        ` : ""}
        ${buildFirmasRemisionHTML(s)}
    `;
    document.getElementById("detail-modal").classList.remove("hidden");
    renderIcons();
}

// =====================================================================
// CONFIGURACIÓN Y UTILIDADES
// =====================================================================
function loadConfigForm() {
    document.getElementById("cfg-tela-nombre").value = appConfig.telaNombre;
    document.getElementById("cfg-tela-email").value = appConfig.telaEmail;
    document.getElementById("cfg-despachador-nombre").value = appConfig.despachadorNombre || appConfig.telaNombre || "";
    document.getElementById("cfg-insumo-nombre").value = appConfig.insumoNombre;
    document.getElementById("cfg-insumo-email").value = appConfig.insumoEmail;
    document.getElementById("cfg-ing-nombre").value = appConfig.ingNombre;
    document.getElementById("cfg-ing-email").value = appConfig.ingEmail;
    document.getElementById("cfg-contabilidad-nombre").value = appConfig.contabilidadNombre || "";
    document.getElementById("cfg-contabilidad-email").value = appConfig.contabilidadEmail || "";
    document.getElementById("cfg-public-base-url").value = appConfig.publicBaseUrl || APP_SYSTEM.publicBaseUrl || "";
}

function saveConfig(e) {
    e.preventDefault();
    if (!requierePermiso("configurar")) return;
    appConfig = {
        telaNombre: document.getElementById("cfg-tela-nombre").value.trim(),
        telaEmail: document.getElementById("cfg-tela-email").value.trim(),
        despachadorNombre: document.getElementById("cfg-despachador-nombre").value.trim() || document.getElementById("cfg-tela-nombre").value.trim(),
        insumoNombre: document.getElementById("cfg-insumo-nombre").value.trim(),
        insumoEmail: document.getElementById("cfg-insumo-email").value.trim(),
        ingNombre: document.getElementById("cfg-ing-nombre").value.trim(),
        ingEmail: document.getElementById("cfg-ing-email").value.trim(),
        contabilidadNombre: document.getElementById("cfg-contabilidad-nombre").value.trim() || DEFAULT_CONFIG.contabilidadNombre,
        contabilidadEmail: document.getElementById("cfg-contabilidad-email").value.trim() || DEFAULT_CONFIG.contabilidadEmail,
        publicBaseUrl: document.getElementById("cfg-public-base-url").value.trim().replace(/\/+$/, "")
    };
    saveAllState();
    updateLiveRoutingSummary();
    showToast("Destinatarios y enlace de firma guardados");
}

function resetDemoData() {
    if (!requierePermiso("configurar")) return;
    DataStore.resetAll();
    appConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    appPlantas = JSON.parse(JSON.stringify(DEFAULT_PLANTAS));
    appFichas = [];
    appSolicitudes = [];
    appFirmas = {};
    appFirmasDespachos = {};
    loadConfigForm();
    populatePlantasSelectors();
    renderConfigPlantasList();
    saveAllState();
    switchRole(currentRole);
    showToast("Configuración inicial restaurada");
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add("hidden");
    if (id === "email-modal") {
        pendingCommitCallback = null;
        pendingEmailPayload = null;
    }
}

function showToast(msg) {
    const toast = document.getElementById("toast");
    document.getElementById("toast-msg").textContent = msg;
    toast.classList.remove("translate-y-24", "opacity-0");
    setTimeout(() => {
        toast.classList.add("translate-y-24", "opacity-0");
    }, 3200);
}

// Sincronización automática en tiempo real con Firebase Realtime Database
DataStore.suscribirTiempoReal(() => {
    appConfig = DataStore.load(DataStore.KEYS.CONFIG, DEFAULT_CONFIG);
    if (!appConfig.despachadorNombre) {
        appConfig.despachadorNombre = appConfig.telaNombre || DEFAULT_CONFIG.despachadorNombre;
    }
    if (!appConfig.contabilidadEmail) appConfig.contabilidadEmail = DEFAULT_CONFIG.contabilidadEmail;
    if (!appConfig.contabilidadNombre) appConfig.contabilidadNombre = DEFAULT_CONFIG.contabilidadNombre;
    if (!appConfig.publicBaseUrl) appConfig.publicBaseUrl = DEFAULT_CONFIG.publicBaseUrl;
    appPlantas = DataStore.load(DataStore.KEYS.PLANTAS, DEFAULT_PLANTAS);
    appFichas = DataStore.load(DataStore.KEYS.FICHAS, []);
    appSolicitudes = DataStore.load(DataStore.KEYS.SOLICITUDES, []);
    appFirmas = DataStore.load(DataStore.KEYS.FIRMAS, {});
    appFirmasDespachos = DataStore.load(DataStore.KEYS.FIRMAS_DESPACHOS, {});
    aplicarItemsConfirmadosAFichas();
    aplicarFirmasDespachosASolicitudes();
    populatePlantasSelectors();
    renderConfigPlantasList();
    updatePendientesBadges();
    if (currentRole === "central") renderCentralView();
    if (currentRole === "planta") renderPlantaView();
});