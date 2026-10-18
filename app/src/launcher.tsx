import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeMode, loadThemeMode } from "./theme";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
const isReader = window.location.pathname.startsWith("/r/");
let remembered: string | null = null;
try { remembered = localStorage.getItem("scriptorium:ui-mode"); } catch { /* A choice remains available without storage. */ }
if (!isReader && (remembered === "desktop" || remembered === "mobile")) {
  window.location.replace(`/${remembered}/${window.location.search}${window.location.hash}`);
} else {
  createRoot(root).render(isReader ? <App initialTheme={theme} /> : <InterfaceChoice />);
}

function InterfaceChoice() {
  const choose = (mode: "desktop" | "mobile") => {
    try { localStorage.setItem("scriptorium:ui-mode", mode); } catch { /* Direct links remain usable. */ }
    window.location.assign(`/${mode}/${window.location.search}${window.location.hash}`);
  };
  return <section className="empty-state" aria-labelledby="interface-title">
    <p className="eyebrow">Scriptorium</p>
    <h1 id="interface-title">執筆画面を選ぶ</h1>
    <p>同じ作品と回復記録を、使いやすい画面で開きます。</p>
    <p><button type="button" onClick={() => choose("desktop")}>Desktop — キーボードで執筆</button></p>
    <p><button type="button" onClick={() => choose("mobile")}>Mobile — タッチで執筆・読書</button></p>
  </section>;
}
