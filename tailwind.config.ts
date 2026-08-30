import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      screens: {
        // short, wide viewport = a phone rotated into landscape — used by the
        // swipe/property pages to switch to the more immersive desktop-like
        // image treatment instead of just stretching the portrait layout.
        'mobile-landscape': { raw: '(orientation: landscape) and (max-height: 560px)' },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['var(--font-playfair)', 'Playfair Display', 'Georgia', 'serif'],
      },
      colors: {
        navy: {
          DEFAULT: '#1B2A4A',
          light: '#2a3d66',
        },
        gold: {
          DEFAULT: '#B8953F',
          light: '#d4b15a',
        },
        'off-white': '#F8F8F6',
        'accent-letting': '#C41E7A',
        'accent-aesthetics': '#B8953F',
        'accent-commercial': '#4CAF50',
        'accent-sales': '#F5C518',
        'accent-logotype': '#87CEEB',
        'status-available': '#22C55E',
        'status-viewings': '#F59E0B',
        'status-rented': '#EF4444',
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-out',
        'slide-up': 'slideUp 0.6s ease-out',
        'scale-in': 'scaleIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
