import "../../styles.css";
import { createRoot } from "react-dom/client";
import { IonReactRouter } from "@ionic/react-router";
import { SharedApplication } from "../App";
import { installNativeSelectCspCompatibility } from "../browser/nativeSelect";
import { MobileShell } from "../shells/mobile/MobileShell";
import { applyThemeMode, loadThemeMode } from "../theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing React root");
const theme = loadThemeMode();
applyThemeMode(theme);
installNativeSelectCspCompatibility(document);
createRoot(root).render(<IonReactRouter><SharedApplication mode="mobile" Shell={MobileShell} initialTheme={theme} /></IonReactRouter>);
