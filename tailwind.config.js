/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Aptos", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Satoshi", "Aptos", "ui-sans-serif", "system-ui", "sans-serif"]
      },
      colors: {
        ink: "#0f172a",
        paper: "#f6f8fb",
        moss: "#0f766e",
        citron: "#99f6e4",
        rust: "#0e7490"
      },
      boxShadow: {
        panel: "0 18px 50px rgba(15, 23, 42, 0.08)"
      }
    }
  },
  plugins: []
};
