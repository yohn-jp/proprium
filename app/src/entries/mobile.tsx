import "../../styles.css";
import { createRoot } from "react-dom/client";
import { SharedApplication } from "../App";
import { MobileShell } from "../shells/mobile/MobileShell";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
createRoot(root).render(<SharedApplication mode="mobile" Shell={MobileShell} initialTheme={theme} />);
