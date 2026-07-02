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
        ink: "#15181b",
        paper: "#f5f2ea",
        moss: "#36584b",
        citron: "#d7ef69",
        rust: "#b85b38"
      },
      boxShadow: {
        panel: "0 18px 60px rgba(21, 24, 27, 0.10)"
      }
    }
  },
  plugins: []
};
