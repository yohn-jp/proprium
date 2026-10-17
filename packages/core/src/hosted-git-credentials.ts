export interface HostedRepositoryBinding {
  readonly repositoryId: number;
  readonly repositoryLocator: string;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
}

export interface HostedGitCredential {
  readonly username: "x-access-token";
  readonly token: string;
  readonly repositoryId: number;
  readonly permission: "read" | "write";
  readonly runtimeEpoch: number;
  readonly expiresAt: string;
}

export type GitCredentialRequest = {
  readonly operation: "fetch";
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
} | {
  readonly operation: "publish";
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly mutationReceipt: string;
  readonly operationId: string;
  readonly payloadDigest: string;
};

/** Issues a fresh, repository and runtime scoped GitHub App credential for each network operation. */
export interface GitCredentialProvider {
  getCredential(request: GitCredentialRequest): Promise<HostedGitCredential>;
}

export interface PublicationAuthorization {
  readonly receipt: string;
  readonly operationId: string;
  readonly payloadDigest: string;
}

export interface PublicationAuthorizationRequest {
  readonly operationId: string;
  readonly payloadDigest: string;
}
