import "../../styles.css";
import { createRoot } from "react-dom/client";
import { SharedApplication } from "../App";
import { DesktopShell } from "../shells/desktop/DesktopShell";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
createRoot(root).render(<SharedApplication mode="desktop" Shell={DesktopShell} initialTheme={theme} />);
