import { execFileSync } from "node:child_process";
import { createServer as createControlServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleId, ModuleManifest } from "@scriptorium/contracts";
import type { ModuleLoader, ModuleRuntimeOptions } from "@scriptorium/module-runtime";
import { createServer } from "../../packages/api/dist/server.js";
import { CoreStore } from "../../packages/core/dist/index.js";

function requiredSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Playwright must provide ${name}`);
  return value;
}

const stateDir = requiredSetting("SCRIPTORIUM_E2E_STATE_DIR");
const repositoryUrl = requiredSetting("SCRIPTORIUM_E2E_REPOSITORY_URL");
const branch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";
const port = Number.parseInt(process.env.SCRIPTORIUM_E2E_PORT ?? "4173", 10);
const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SCRIPTORIUM_E2E_PORT must be a valid TCP port");
if (authToken.length < 32) throw new Error("SCRIPTORIUM_E2E_AUTH_TOKEN must contain at least 32 characters");

async function createLocalFixture(): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "scriptorium-e2e-repo-"));
  const bareRemote = resolve(repositoryUrl);
  const workingCopy = join(fixtureRoot, "seed");
  await mkdir(workingCopy, { recursive: true });
  await mkdir(join(workingCopy, "plot/volumes/vol-1/chapters/ch-1/scenes"), { recursive: true });
  await mkdir(join(workingCopy, "manuscript/vol-1/ch-1"), { recursive: true });

  await writeFile(join(workingCopy, "plot/volumes/vol-1/volume.yaml"), "id: vol-1\ntitle: Volume One\n", "utf8");
  await writeFile(
    join(workingCopy, "plot/volumes/vol-1/chapters/ch-1/chapter.yaml"),
    "id: ch-1\nvolume: vol-1\ntitle: Chapter One\n",
    "utf8",
  );
  await writeFile(
    join(workingCopy, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml"),
    "id: scene-1\ntitle: Scene One\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-1.md\n",
    "utf8",
  );
  await writeFile(
    join(workingCopy, "manuscript/vol-1/ch-1/scene-1.md"),
    "# Scene One\n\nThe first line of the story.\n",
    "utf8",
  );
  await writeFile(
    join(workingCopy, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml"),
    "id: scene-2\ntitle: Scene Two\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-2.md\n",
    "utf8",
  );
  await writeFile(
    join(workingCopy, "manuscript/vol-1/ch-1/scene-2.md"),
    "# Scene Two\n\nThe second line of the story.\n",
    "utf8",
  );

  const runGit = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Scriptorium Acceptance",
        GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
        GIT_COMMITTER_NAME: "Scriptorium Acceptance",
        GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
      },
    });

  try {
    await mkdir(resolve(bareRemote), { recursive: true });
    execFileSync("git", ["init", "--bare", "--initial-branch", branch, bareRemote], { stdio: "ignore" });
    runGit(workingCopy, "init", "--initial-branch", branch);
    runGit(workingCopy, "add", ".");
    runGit(workingCopy, "commit", "-m", "Add acceptance manuscript fixture");
    runGit(workingCopy, "remote", "add", "origin", bareRemote);
    runGit(workingCopy, "push", "--set-upstream", "origin", branch);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function listen(server: Server, listenPort: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function startTestServer(): Promise<void> {
  if (process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY !== "1") {
    await createLocalFixture();
  }

  const profile = process.env.SCRIPTORIUM_PROFILE ?? "core";
  let runtimeOptions: ModuleRuntimeOptions | undefined;
  if (profile !== "core") {
    const generatedPath = resolve("profiles", profile, "generated", "server.mjs");
    const composition = await import(pathToFileURL(generatedPath).href) as {
      profile: string;
      moduleManifests: ModuleManifest[];
      moduleLoaders: Partial<Record<ModuleId, ModuleLoader>>;
      moduleDirectories: ModuleRuntimeOptions["moduleDirectories"];
      moduleWorkerEntries: ModuleRuntimeOptions["workerEntries"];
    };
    if (composition.profile !== profile) throw new Error(`Generated E2E module profile does not match ${profile}`);
    runtimeOptions = {
      manifests: composition.moduleManifests,
      enabled: composition.moduleManifests.map((manifest) => manifest.id),
      loaders: composition.moduleLoaders,
      moduleDirectories: composition.moduleDirectories,
      workerEntries: composition.moduleWorkerEntries,
      cacheDirectory: join(stateDir, "module-cache"),
    };
  }

  const startApi = async (): Promise<Server> => {
    const store = new CoreStore({ dataDir: join(stateDir, "store"), allowLocalRemotes: true });
    const server = createServer({
      store,
      authToken,
      staticDir: resolve("app/dist"),
      usageDirectory: join(stateDir, "host-history"),
      profile,
      ...(runtimeOptions ? { runtimeOptions } : {}),
    });
    await listen(server, port);
    return server;
  };

  let apiServer = await startApi();
  let resetting = false;
  const controlServer = createControlServer((request, response) => {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST" || (request.url !== "/__e2e/reset-core" && request.url !== "/__e2e/restart-api")) {
      response.writeHead(404).end();
      return;
    }
    const resetCore = request.url === "/__e2e/reset-core";
    request.resume();
    if (resetting) {
      response.writeHead(409).end("Core reset is already in progress");
      return;
    }
    resetting = true;
    void (async () => {
      try {
        await close(apiServer);
        if (resetCore) {
          // The disposable Git remote and private host usage store intentionally survive Core loss.
          await rm(join(stateDir, "store"), { recursive: true, force: true });
        }
        apiServer = await startApi();
        response.writeHead(204).end();
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          .end(error instanceof Error ? error.message : "Core reset failed");
      } finally {
        resetting = false;
      }
    })();
  });
  const controlPort = port + 1;
  if (!Number.isInteger(controlPort) || controlPort > 65_535) throw new Error("The E2E control port must be valid");
  await listen(controlServer, controlPort);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void close(controlServer);
    void close(apiServer).finally(() => {
      if (process.env.SCRIPTORIUM_E2E_TEMP_STATE_DIR === "1") {
        void rm(stateDir, { recursive: true, force: true });
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void startTestServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Scriptorium E2E test server failed");
  process.exitCode = 1;
});
