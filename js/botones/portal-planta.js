// js/botones/portal-planta.js
// Botón principal: portal de Planta Externa.

registrarBotonPrincipal({
    contenedor: "portales-botones",
    id: "role-btn-planta",
    texto: "2. Planta Externa",
    icono: "factory",
    onclick: "switchRole('planta')",
    activo: false,
    clasesBase: "flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-lg text-xs transition-all",
    clasesActivas: "bg-yellow-400 text-zinc-950 font-extrabold shadow-sm",
    clasesInactivas: "text-zinc-300 font-bold hover:text-white hover:bg-zinc-800"
});
