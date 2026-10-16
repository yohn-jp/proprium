export async function resolve(specifier, context, nextResolve) {
  if (specifier === "lindera-wasm-nodejs-ipadic") {
    throw new Error("Lindera engine import is forbidden in the parent module process");
  }
  return nextResolve(specifier, context);
}
