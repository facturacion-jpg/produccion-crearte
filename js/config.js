// js/config.js
// Configuración centralizada - Producción | Crearte By Confeccionarte SAS

const APP_SYSTEM = {
    nombreApp: "Producción",
    empresa: "Crearte By Confeccionarte SAS",
    nit: "NIT. 901.367.620-0",
    logoUrl: "img/logo.png",
    subtitulo: "Control de Fichas Técnicas, Salidas y Plantas Externas",
    version: "2.0.0-corporativo",
    // Reemplazar por la URL de tu propio Web App de Google Apps Script.
    apiCorreoPdfUrl: "https://script.google.com/macros/s/AKfycbym1iYMtBp10Hz8i_U2MD-MrRDGTCQdFBtKztpzK3_MVVBj9k0w5VSrmcuYM97lwmak/exec",
    // Web App de Apps Script para login con Google Sheets. Vacío = sin login.
    // Ejemplo: "https://script.google.com/macros/s/AKfycb.../exec"
    apiAuthUrl: "https://script.google.com/macros/s/AKfycbw9mU3jE4Z-Y8xPKxIZHsuVBPUUskQwlQOgYNJN1koDYGmJBMXEHoIrCTvk3E2sIgQi/exec",
    // URL pública del sitio (GitHub Pages). Se usa para armar el enlace de firma.
    // Sin barra final. Si está vacío se usa el origen actual.
    publicBaseUrl: "https://facturacion-jpg.github.io/produccion-crearte",
    panelCentralUrl: "",
    // Se envía al Script dentro del payload como comprobación básica.
    // NO es un secreto: viaja en el código del navegador. No usar contraseñas aquí.
    tokenIntegracion: "crrt_24347c636c95457c9c7c23160ab23321"
};

// Las claves web de Firebase son públicas por diseño. La protección real está
// en las reglas de la Realtime Database, no en estas claves.
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyB1j-5yMMJLvqH6euJePbNoMUA2HyTKI60",
    authDomain: "crearte-produccion.firebaseapp.com",
    databaseURL: "https://crearte-produccion-default-rtdb.firebaseio.com",
    projectId: "crearte-produccion",
    storageBucket: "crearte-produccion.firebasestorage.app",
    messagingSenderId: "880815435574",
    appId: "1:880815435574:web:14fdac1ee4470b1540cd97",
    measurementId: "G-WS2L3JDMMD"
};

const DEFAULT_CONFIG = {
    telaNombre: "Encargado Bodega de Telas",
    telaEmail: "bodega.telas@crearteconfeccionarte.com",
    // Nombre que aparece como firma automática del despachador en la remisión.
    despachadorNombre: "Encargado Bodega de Telas",
    insumoNombre: "Encargado Almacén de Insumos",
    insumoEmail: "almacen.insumos@crearteconfeccionarte.com",
    ingNombre: "Ingeniería y Producción - Crearte By Confeccionarte SAS",
    ingEmail: "produccion@crearteconfeccionarte.com",
    contabilidadNombre: "Contabilidad Crearte",
    contabilidadEmail: "contabilidad@crearteconfeccionarte.com",
    // Se puede llenar desde Configuración. Si queda vacío, se usa el origen
    // actual cuando la app se abre por http(s).
    publicBaseUrl: ""
};

// No hay plantas predeterminadas: se registran desde Configuración.
const DEFAULT_PLANTAS = [];