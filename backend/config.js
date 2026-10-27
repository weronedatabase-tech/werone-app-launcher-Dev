// ==========================================================
// ⚙️ WERONE ENVIRONMENT CONFIGURATION
// ==========================================================
// Change APP_ENV between "DEV" and "PROD" to switch the active
// environment across the entire application. No other file
// requires modification when switching environments.
// ==========================================================

const APP_ENV = "DEV"; // Options: "DEV" | "PROD"

const ENV_CONFIG = {
    DEV: {
        ID: "DEV",
        GAS_WEBAPP_URL: "https://script.google.com/macros/s/AKfycbw_WV5UIMt2A_0JnDuIDtjbUAWJFGBRPl-p_7uVP060ryqISRz0jaWSHJwNPC7h0Mw05A/exec",
        APP_NAME: "WERONE (Dev)",
        SHORT_NAME: "WERONE Dev",
        CACHE_KEY: "hubAppsData_DEV",
        SHOW_DEV_BANNER: true,
        DEV_BANNER_TEXT: "DEV"
    },
    PROD: {
        ID: "PROD",
        GAS_WEBAPP_URL: "https://script.google.com/macros/s/AKfycbyDQFQnmqmooqLSwKbhNxiK6nsJF0ywMZlvmPVbE0YQHhOM4G5vGCbSOQDIpC0WN3XU/exec",
        APP_NAME: "WERONE",
        SHORT_NAME: "WERONE",
        CACHE_KEY: "hubAppsData_PROD",
        SHOW_DEV_BANNER: false,
        DEV_BANNER_TEXT: ""
    }
};

const ACTIVE_CONFIG = ENV_CONFIG[APP_ENV] || ENV_CONFIG.PROD;
const GAS_WEBAPP_URL = ACTIVE_CONFIG.GAS_WEBAPP_URL;

window.WERONE_CONFIG = {
    APP_ENV,
    GAS_WEBAPP_URL,
    ...ACTIVE_CONFIG
};
