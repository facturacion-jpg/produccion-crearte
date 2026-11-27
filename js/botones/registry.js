// js/botones/registry.js
// Registro de botones principales. Cada botón se declara en su propio archivo
// dentro de esta carpeta y se renderiza en el contenedor indicado.

const BOTONES_PRINCIPALES = [];

function registrarBotonPrincipal(config) {
    BOTONES_PRINCIPALES.push(config);
}

function htmlBotonPrincipal(b) {
    const base = b.clasesBase || "";
    const estado = b.activo ? (b.clasesActivas || "") : (b.clasesInactivas || "");
    const tamanoIcono = b.iconoTamano || "4";
    const icono = b.icono
        ? `<i data-lucide="${b.icono}" class="w-${tamanoIcono} h-${tamanoIcono} flex-shrink-0"></i>`
        : "";
    const badge = b.badgeId
        ? `<span id="${b.badgeId}" class="${b.badgeClases || "px-1.5 py-0.5 rounded-full text-[10px] font-black"}">0</span>`
        : "";
    const clases = [base, estado, b.clasesExtra || ""].filter(Boolean).join(" ");
    return `<button type="button" onclick="${b.onclick}" id="${b.id}" class="${clases}">${icono}<span class="truncate">${b.texto}</span>${badge}</button>`;
}

function renderBotonesPrincipales() {
    const grupos = BOTONES_PRINCIPALES.reduce((acc, b) => {
        (acc[b.contenedor] = acc[b.contenedor] || []).push(b);
        return acc;
    }, {});

    Object.keys(grupos).forEach(idContenedor => {
        const contenedor = document.getElementById(idContenedor);
        if (contenedor) {
            contenedor.innerHTML = grupos[idContenedor].map(htmlBotonPrincipal).join("");
        }
    });

    if (window.lucide && typeof lucide.createIcons === "function") {
        lucide.createIcons();
    }
}
