// js/botones/portal-central.js
// Botón principal: portal de Gestión Central.

registrarBotonPrincipal({
    contenedor: "portales-botones",
    id: "role-btn-central",
    texto: "1. Gestión Central",
    icono: "layout-dashboard",
    onclick: "switchRole('central')",
    activo: true,
    badgeId: "badge-pendientes-count",
    badgeClases: "px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-950 text-yellow-400 font-black",
    clasesBase: "flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-lg text-xs transition-all",
    clasesActivas: "bg-yellow-400 text-zinc-950 font-extrabold shadow-sm",
    clasesInactivas: "text-zinc-300 font-bold hover:text-white hover:bg-zinc-800"
});
