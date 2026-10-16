/** Path-only credential filter shared by Git discovery and operation planning. */
export function isSecretLegacyPath(value: string): boolean {
  const segments = value.replaceAll("\\", "/").split("/").map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? value.toLowerCase();
  const hasPath = (...suffix: string[]) => suffix.every((segment, index) =>
    segments[segments.length - suffix.length + index] === segment);
  const containsPath = (...sequence: string[]) => segments.some((_, index) =>
    sequence.every((segment, offset) => segments[index + offset] === segment));
  const sshPrivateKey = segments.includes(".ssh")
    && /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.(?:pem|key))?$/.test(basename);
  const conventionalCredentialPath = [
    [".config", "git", "credentials"],
    [".config", "gh", "hosts.yml"],
    [".config", "gcloud", "credentials.db"],
    [".config", "gcloud", "access_tokens.db"],
    ["gcloud", "credentials.db"],
    ["gcloud", "access_tokens.db"],
    [".aws", "credentials"],
    ["aws", "credentials"],
    [".azure", "accessTokens.json".toLowerCase()],
    [".docker", "config.json"],
    [".kube", "config"],
  ].some((suffix) => hasPath(...suffix));
  const gcloudLegacyCredentials = containsPath("gcloud", "legacy_credentials");
  return /(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|password|passwd|private[_-]?key)(?:[._-]|$)/i.test(value)
    || /^\.env(?:\.|$)/i.test(basename)
    || /\.(?:pem|key|p12|pfx)$/i.test(basename)
    || basename === ".npmrc"
    || basename === ".git-credentials"
    || basename === ".gitconfig"
    || basename === ".netrc"
    || basename === ".pypirc"
    || sshPrivateKey
    || conventionalCredentialPath
    || gcloudLegacyCredentials;
}
