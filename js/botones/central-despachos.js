// js/botones/central-despachos.js
// Pestaña principal de Gestión Central: solicitudes y despachos.

registrarBotonPrincipal({
    contenedor: "central-subtabs",
    id: "cen-tab-despachos",
    texto: "Solicitudes y Despachos",
    icono: "warehouse",
    iconoTamano: "3.5",
    onclick: "switchSubTab('cen', 'despachos')",
    activo: false,
    badgeId: "subtab-pend-badge",
    badgeClases: "px-1.5 py-0.2 rounded-full text-[10px] bg-yellow-400 text-zinc-950 font-black",
    clasesBase: "cen-subtab inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 rounded-xl text-xs transition-all",
    clasesActivas: "bg-zinc-950 text-yellow-400 font-extrabold shadow-sm",
    clasesInactivas: "bg-zinc-100 text-zinc-700 font-bold hover:bg-zinc-200"
});
