import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", ...defaultTheme.fontFamily.sans],
      },
      // Minimal-premium tokens. Every kit component reads these CSS vars instead of literal colors,
      // so the chrome is consistent and a wrapper that overrides --brand* (the R3 white-label portal)
      // re-themes its whole subtree with no component change.
      colors: {
        brand: {
          DEFAULT: "var(--brand)",
          strong: "var(--brand-strong)",
          fg: "var(--brand-fg)",
          tint: "var(--brand-tint)",
          "tint-fg": "var(--brand-tint-fg)",
        },
        surface: {
          DEFAULT: "var(--surface-2)", // cards / panels / rows
          muted: "var(--surface-1)", // insets / hover
          sunken: "var(--surface-0)", // page canvas
        },
        hairline: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        ink: {
          DEFAULT: "var(--text-primary)",
          muted: "var(--text-secondary)",
          subtle: "var(--text-muted)",
        },
      },
      // Hairline borders everywhere (0.5px); the default border color is the neutral token.
      borderColor: {
        DEFAULT: "var(--border)",
      },
      borderWidth: {
        DEFAULT: "0.5px",
      },
      // Small, crisp radii: 10px cards, 8px controls. (md=6px kept for tiny chips.)
      borderRadius: {
        lg: "0.5rem", // 8px controls
        xl: "0.5rem", // 8px controls
        "2xl": "0.625rem", // 10px cards
      },
    },
  },
  plugins: [],
};

export default config;
