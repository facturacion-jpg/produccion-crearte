// js/botones/central-enviar.js
// Pestaña principal de Gestión Central: enviar ficha técnica + salida.

registrarBotonPrincipal({
    contenedor: "central-subtabs",
    id: "cen-tab-enviar",
    texto: "Enviar Ficha + Salida",
    icono: "send",
    iconoTamano: "3.5",
    onclick: "switchSubTab('cen', 'enviar')",
    activo: true,
    clasesBase: "cen-subtab inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 rounded-xl text-xs transition-all",
    clasesActivas: "bg-zinc-950 text-yellow-400 font-extrabold shadow-sm",
    clasesInactivas: "bg-zinc-100 text-zinc-700 font-bold hover:bg-zinc-200"
});
