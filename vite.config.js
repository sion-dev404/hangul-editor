import { defineConfig } from 'vite';

// index.html = 홍보 페이지(검색에 걸리는 첫 화면), app.html = 편집기
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { index: 'index.html', app: 'app.html' } },
  },
});
