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
      // "Fresh" themeable accent — every kit component reads these instead of a hardcoded teal,
      // so a wrapper that overrides the --brand* vars (R3 white-label portal) re-themes everything.
      colors: {
        brand: {
          DEFAULT: "var(--brand)",
          strong: "var(--brand-strong)",
          fg: "var(--brand-fg)",
          tint: "var(--brand-tint)",
          "tint-fg": "var(--brand-tint-fg)",
        },
      },
      borderRadius: {
        // Cards = 16px; controls land on the built-in xl (12px) / lg (8px).
        "2xl": "1rem",
      },
    },
  },
  plugins: [],
};

export default config;
