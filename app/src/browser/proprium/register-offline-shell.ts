if (!import.meta.env.DEV && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/proprium-sw.js", { scope: "/" }).catch(error => {
    window.dispatchEvent(new CustomEvent("proprium:offline-shell-unavailable", { detail: error }));
  });
}
