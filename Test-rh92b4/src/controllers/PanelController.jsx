import ReactDOM from "react-dom";

// Inject minimal theme styles once for class-based theming
const THEME_STYLE_ID = "udt-theme-styles";
function injectThemeStyles() {
    if (document.getElementById(THEME_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    style.textContent = `
    .theme-dark { color: #fff; }
    .theme-light { color: #000; }
    `;
    document.head.appendChild(style);
}

const _id = Symbol("_id");
const _root = Symbol("_root");
const _attachment = Symbol("_attachment");
const _Component = Symbol("_Component");
const _menuItems = Symbol("_menuItems");

export class PanelController {
    
    constructor(Component, { id, menuItems } = {}) {
        this[_id] = null;
        this[_root] = null;
        this[_attachment] = null;
        this[_Component] = null;
        this[_menuItems] = [];

        this[_Component] = Component;
        this[_id] = id;
        this[_menuItems] = menuItems || [];
        this.menuItems = this[_menuItems].map(menuItem => ({
            id: menuItem.id,
            label: menuItem.label,
            enabled: menuItem.enabled || true,
            checked: menuItem.checked || false
        }));

        [ "create", "show", "hide", "destroy", "invokeMenu" ].forEach(fn => this[fn] = this[fn].bind(this));
    }

    create() {
        this[_root] = document.createElement("div");
        this[_root].style.height = "100vh";
        this[_root].style.overflow = "auto";
        this[_root].style.padding = "8px";

        // Ensure theme styles are available
        injectThemeStyles();

        // Apply current theme and subscribe to updates if available.
        const applyTheme = (theme) => {
            if (!this[_root]) return;
            const isDark = typeof theme === "string" && theme.toLowerCase().includes("dark");
            this[_root].classList.toggle("theme-dark", !!isDark);
            this[_root].classList.toggle("theme-light", !isDark);
        };

        const themeApi = (document && document.theme) ? document.theme : null;
        if (themeApi) {
            try {
                const currentTheme = themeApi.getCurrent && themeApi.getCurrent();
                if (currentTheme) applyTheme(currentTheme);
                if (themeApi.onUpdated && themeApi.onUpdated.addListener) {
                    themeApi.onUpdated.addListener(applyTheme);
                }
            } catch (_) {
                // If theme API is unavailable at runtime, safely ignore.
            }
        }

        ReactDOM.render(this[_Component]({panel: this}), this[_root]);

        return this[_root];
    }

    show(event)  {
        if (!this[_root]) this.create();
        this[_attachment] = event;
        this[_attachment].appendChild(this[_root]);
    }

    hide() {
        if (this[_attachment] && this[_root]) {
            this[_attachment].removeChild(this[_root]);
            this[_attachment] = null;
        }
    }

    destroy() { }

    invokeMenu(id) {
        const menuItem = this[_menuItems].find(c => c.id === id);
        if (menuItem) {
            const handler = menuItem.oninvoke;
            if (handler) {
                handler();
            }
        }
    }
}
