import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyThemeMode, loadThemeMode } from "./theme";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");

const initialTheme = loadThemeMode();
applyThemeMode(initialTheme);
createRoot(root).render(<App initialTheme={initialTheme} />);
