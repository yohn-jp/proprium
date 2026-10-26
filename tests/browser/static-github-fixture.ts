import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { installMockGitHubOAuth } from "../helpers/github-relay-fixture.js";

export const staticFixtureIdentity = {
  origin: "https://github.com",
  repositoryId: 923456789,
  owner: "proprium-static-fixture",
  repository: "browser-static-fixture",
  branch: "acceptance",
};
export const staticFixtureLogin = "proprium-static-fixture";
export const staticFixtureTitle = `${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository} · ${staticFixtureIdentity.branch}`;

interface FixtureCommit {
  sha: string;
  treeSha: string;
  blobSha: string;
  content: Uint8Array;
  api: Record<string, unknown>;
}

function gitObjectSha(type: string, content: Uint8Array): string {
  return createHash("sha1").update(`${type} ${content.byteLength}\0`).update(content).digest("hex");
}

function commitFixture(content: string, mode: "100644" | "100755"): FixtureCommit {
  const bytes = new TextEncoder().encode(content);
  const blobSha = gitObjectSha("blob", bytes);
  const tree = Buffer.concat([
    Buffer.from(`${mode} README.md\0`, "utf8"),
    Buffer.from(blobSha, "hex"),
  ]);
  const treeSha = gitObjectSha("tree", tree);
  const timestamp = 1_704_067_200;
  const identity = `Proprium Static Fixture <static-fixture@example.test> ${timestamp} +0000`;
  const message = "Static browser acceptance fixture\n";
  const payload = Buffer.from(`tree ${treeSha}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`, "utf8");
  const sha = gitObjectSha("commit", payload);
  return {
    sha,
    treeSha,
    blobSha,
    content: bytes,
    api: {
      sha,
      commit: {
        tree: { sha: treeSha },
        message,
        author: { name: "Proprium Static Fixture", email: "static-fixture@example.test", date: "2024-01-01T00:00:00Z" },
        committer: { name: "Proprium Static Fixture", email: "static-fixture@example.test", date: "2024-01-01T00:00:00Z" },
        verification: { signature: null },
      },
      parents: [],
    },
  };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type, X-GitHub-Api-Version",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** Emulates only the GitHub OAuth and read APIs needed to select a branch and open one real Git commit. */
export async function installStaticGitHubFixture(page: Page, hostOrigin: string, mode: "100644" | "100755" = "100644"): Promise<{ head: string; content: string; apiRequests(): number; apiPaths(): string[] }> {
  const context = page.context();
  const fixtureContent = "A synthetic GitHub commit imported through the static Host.\n";
  const fixture = commitFixture(fixtureContent, mode);
  const fakeToken = "proprium-static-fixture-only-token";
  let apiRequestCount = 0;
  const apiPaths: string[] = [];

  await installMockGitHubOAuth(page, {
    relayUrl: hostOrigin, hostOrigin, accessToken: fakeToken,
    deviceCode: "static-fixture-device-code", userCode: "STAT-IC01",
  });

  await context.route("https://api.github.com/**", async route => {
    const source = route.request();
    const requestUrl = new URL(source.url());
    const cors = corsHeaders(hostOrigin);
    if (source.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    apiRequestCount += 1;
    apiPaths.push(`${source.method()} ${requestUrl.pathname}`);
    const json = (payload: unknown, status = 200) => route.fulfill({
      status,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
    if (source.headers().authorization !== `Bearer ${fakeToken}`) return json({ message: "Bad credentials" }, 401);
    if (requestUrl.pathname === "/user") return json({ id: 91, login: staticFixtureLogin });
    if (requestUrl.pathname === "/user/repos") return json([{
      id: staticFixtureIdentity.repositoryId,
      full_name: `${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository}`,
      name: staticFixtureIdentity.repository,
      owner: { login: staticFixtureIdentity.owner },
      default_branch: staticFixtureIdentity.branch,
      private: false,
      permissions: { pull: true, push: true },
    }]);

    const repoPath = `/repos/${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository}`;
    if (requestUrl.pathname === repoPath) return json({
      id: staticFixtureIdentity.repositoryId,
      name: staticFixtureIdentity.repository,
      full_name: `${staticFixtureIdentity.owner}/${staticFixtureIdentity.repository}`,
      owner: { login: staticFixtureIdentity.owner },
      permissions: { pull: true, push: true },
    });
    if (requestUrl.pathname === `${repoPath}/branches`) return json([{ name: staticFixtureIdentity.branch }]);
    if (requestUrl.pathname === `${repoPath}/git/ref/heads/${staticFixtureIdentity.branch}`) return json({
      ref: `refs/heads/${staticFixtureIdentity.branch}`,
      object: { type: "commit", sha: fixture.sha },
    });
    if (requestUrl.pathname === `${repoPath}/commits/${fixture.sha}`) return json(fixture.api);
    if (requestUrl.pathname === `${repoPath}/git/trees/${fixture.treeSha}`) return json({
      sha: fixture.treeSha,
      truncated: false,
      tree: [{ path: "README.md", mode, type: "blob", sha: fixture.blobSha }],
    });
    if (requestUrl.pathname === `${repoPath}/git/blobs/${fixture.blobSha}`) return json({
      sha: fixture.blobSha,
      size: fixture.content.byteLength,
      encoding: "base64",
      content: Buffer.from(fixture.content).toString("base64"),
    });
    return json({ message: `Unexpected ${source.method()} ${requestUrl.pathname}` }, 404);
  });

  return { head: fixture.sha, content: fixtureContent, apiRequests: () => apiRequestCount, apiPaths: () => [...apiPaths] };
}
