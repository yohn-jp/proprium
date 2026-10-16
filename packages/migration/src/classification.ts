/** Path-only credential filter shared by Git discovery and operation planning. */
export function isSecretLegacyPath(value: string): boolean {
  const basename = value.split("/").at(-1) ?? value;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|password|passwd|private[_-]?key)(?:[._-]|$)/i.test(value)
    || /^\.env(?:\.|$)/i.test(basename)
    || /\.(?:pem|key|p12|pfx)$/i.test(basename);
}
