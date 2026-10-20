import React from "react";
import ReactDOM from "react-dom/client";
// 字体经 JS 侧导入，Vite 才会正确改写 woff2 资源路径（放 CSS @import 会 404）
import "@fontsource-variable/geist";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
