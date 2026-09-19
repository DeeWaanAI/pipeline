/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,ts,md,mdx}"],
  theme: {
    extend: {
      colors: {
        // Single accent, used consistently (electric cyan family).
        accent: {
          DEFAULT: "#22d3ee",
          soft: "#67e8f9",
          dim: "#0e7490",
        },
        ink: {
          950: "#0a0a0b",
          900: "#121214",
          850: "#18181b",
          800: "#1f1f23",
          700: "#2e2e34",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI",
          "Roboto", "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
