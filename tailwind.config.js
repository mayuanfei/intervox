/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#19212a",
        mist: "#f5f7fb",
        line: "#dce3ec",
        pine: "#0f766e",
        plum: "#7c3aed",
        flame: "#dc2626",
      },
      boxShadow: {
        toolbar: "0 1px 2px rgba(25, 33, 42, 0.08)",
      },
    },
  },
  plugins: [],
};
