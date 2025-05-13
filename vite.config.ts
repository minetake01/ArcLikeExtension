import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path"; // pathモジュールをインポート

export default defineConfig({
    plugins: [tailwindcss()],
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                popup: resolve(__dirname, "popup.html"),
                background: resolve(__dirname, "src/background.ts"),
            },
            output: {
                entryFileNames: (chunkInfo) => {
                    // 'background' エントリーポイントは 'background.js' として出力します。
                    if (chunkInfo.name === "background") {
                        return "[name].js"; // dist/background.js になります
                    }
                    // popup.html に関連するJSファイルなどは assets ディレクトリに出力します。
                    return "assets/[name]-[hash].js";
                },
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash].[ext]",
            },
        },
    },
});
