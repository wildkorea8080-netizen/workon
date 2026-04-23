import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      colors: {
        // 정부 파란색 기본 팔레트 (brand-* 로 기존 코드와 호환)
        brand: {
          DEFAULT: '#003087',
          50:  '#E6EBF5',
          100: '#CCD7EB',
          200: '#99AFCF',
          300: '#6687B3',
          400: '#335F97',
          500: '#003087',
          600: '#003087',
          700: '#002070',
          800: '#001559',
          900: '#000A42',
        },
        // 직접 사용용 별칭
        primary:       '#003087',
        'primary-light': '#0066CC',
        'primary-dark':  '#002070',
        sidebar:       '#1C2B4A',
        accent:        '#FF6B00',
        success:       '#28A745',
        warning:       '#FFC107',
        danger:        '#DC3545',
      },
    },
  },
  plugins: [],
};

export default config;
