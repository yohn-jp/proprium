import { useEffect, useState } from "react";
import { isWritingKeyboardVisible } from "./mobileKeyboard";

/** Change only visual chrome. The editor DOM, selection and recovery controller are untouched. */
export function useWritingKeyboardVisibility(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let lastUnfocusedHeight = window.innerHeight;
    let width = window.innerWidth;
    let frame: number | null = null;
    const measure = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        // Orientation changes are not keyboard activity.
        lastUnfocusedHeight = window.innerHeight;
      }
      const active = document.activeElement;
      const editorFocused = active instanceof HTMLElement && active.closest(".cm-content") !== null;
      if (!editorFocused) lastUnfocusedHeight = window.innerHeight;
      const viewport = window.visualViewport;
      setVisible(isWritingKeyboardVisible({
        editorFocused,
        lastUnfocusedHeight,
        windowHeight: window.innerHeight,
        visualHeight: viewport?.height ?? null,
        visualScale: viewport?.scale ?? 1,
      }));
    };
    const afterBlur = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("focusin", measure);
    document.addEventListener("focusout", afterBlur);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("focusout", afterBlur);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, []);
  return visible;
}
