const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Keep React-created native selects usable under strict CSP in WebKit 27.2.
 * WebKit reports a style-src-attr violation when a native SELECT is created
 * with Document.createElement, even when the application never assigns an
 * inline style. Parsing a constant, style-free SELECT avoids that browser path.
 */
export function installNativeSelectCspCompatibility(doc: Document): void {
  const nativeCreateElement = doc.createElement;

  function createElement<K extends keyof HTMLElementTagNameMap>(
    this: Document,
    localName: K,
    options?: ElementCreationOptions,
  ): HTMLElementTagNameMap[K];
  function createElement(this: Document, localName: string, options?: ElementCreationOptions): HTMLElement;
  function createElement(this: Document, localName: string, options?: ElementCreationOptions): HTMLElement {
    if (
      this === doc &&
      typeof localName === "string" &&
      localName.toLowerCase() === "select" &&
      options == null
    ) {
      const template = Reflect.apply(nativeCreateElement, doc, ["template"]) as HTMLTemplateElement;
      template.innerHTML = "<select></select>";
      const select = template.content.firstElementChild;
      if (!select || select.localName !== "select" || select.namespaceURI !== XHTML_NAMESPACE) {
        throw new Error("Could not create a native select from the static HTML template.");
      }
      return doc.adoptNode(select) as HTMLSelectElement;
    }

    return Reflect.apply(nativeCreateElement, this, arguments) as HTMLElement;
  }

  doc.createElement = createElement as Document["createElement"];
}
