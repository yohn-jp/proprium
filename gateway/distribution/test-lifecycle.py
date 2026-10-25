#!/usr/bin/env python3
"""Real user-systemd lifecycle integration test; only GitHub/public HTTPS is stubbed."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[2]
DIST = ROOT / "gateway" / "distribution"
GO = os.environ.get("GO", "go")


def run(args, *, env=None, cwd=ROOT, check=True, timeout=60, input=None):
    p = subprocess.run(args, cwd=cwd, env=env, input=input, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and p.returncode:
        raise AssertionError(f"command failed ({p.returncode}): {args}\nstdout: {p.stdout}\nstderr: {p.stderr}")
    return p


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data)
    path.chmod(mode)


def build_fixtures(base, work):
    gateway = work / "gateway"
    run([GO, "build", "-trimpath", "-o", str(gateway), "."], cwd=ROOT / "gateway", timeout=180)
    tunnel_src = work / "cloudflared.go"
    (work / "go.mod").write_text("module lifecyclefixture\n\ngo 1.27\n")
    tunnel_src.write_text(r'''package main
import ("fmt"; "net/http"; "os"; "strings")
var ready = "yes"
func main() {
  if os.Getenv("PROPRIUM_OWNER_KEY") != "" || os.Getenv("GITHUB_CLIENT_ID") != "" || os.Getenv("CF_ACCESS_CLIENT_SECRET") != "" { os.Exit(5) }
  addr := "127.0.0.1:20000"
  hasConfig := false
  for i, a := range os.Args {
    if a == "--metrics" && i+1 < len(os.Args) { addr = os.Args[i+1] }
    if a == "--config" && i+1 < len(os.Args) {
      hasConfig = true
      config, err := os.ReadFile(os.Args[i+1])
      if err != nil { os.Exit(6) }
      if os.Getenv("TUNNEL_TOKEN") == "" && !strings.Contains(string(config), "credentials-file:") { os.Exit(8) }
    }
  }
  if !hasConfig { os.Exit(7) }
  if os.Getenv("TUNNEL_TOKEN") == "" && !strings.HasPrefix(os.Args[len(os.Args)-1], "12345678-") { os.Exit(9) }
  http.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) { if ready != "yes" { w.WriteHeader(503); return }; fmt.Fprint(w, "ok") })
  if strings.Contains(addr, "0.0.0.0") { os.Exit(3) }
  if err := http.ListenAndServe(addr, nil); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
}
''')
    versions = {"1.0.0": "yes", "1.0.1": "yes", "1.0.2": "yes", "1.0.3": "yes",
                "1.0.4": "no", "1.0.5": "yes", "1.0.6": "yes"}
    for version, ready in versions.items():
        directory = base / version
        directory.mkdir(parents=True)
        tunnel = directory / "cloudflared"
        run([GO, "build", "-trimpath", "-ldflags", f"-X main.ready={ready}", "-o", str(tunnel), str(tunnel_src)], cwd=work, timeout=180)
        bundle = work / f"{version}.tar.gz"
        files = {
            "gateway": gateway,
            "cloudflared": tunnel,
            "proprium": DIST / "proprium",
            "manifest": None,
            "SOURCE.txt": None,
            "LICENSE-GATEWAY.txt": None,
            "LICENSE-CLOUDFLARED.txt": None,
            "NOTICE-CLOUDFLARED.txt": ROOT / "gateway/distribution/NOTICE-CLOUDFLARED.txt",
            "THIRD-PARTY-LICENSES.txt": None,
        }
        manifest = ("schema=proprium-gateway-bundle-v1\nversion=" + version +
                    "\nos=linux\narch=amd64\ncommit=" + "a" * 40 + "\n")
        for name, source in (("gateway", gateway), ("cloudflared", tunnel), ("proprium", DIST / "proprium")):
            manifest += f"{name}_sha256={sha(source)}\n"
        payloads = {
            "manifest": manifest.encode(),
            "SOURCE.txt": ("commit=" + "a" * 40 + "\n").encode(),
            "LICENSE-GATEWAY.txt": b"fixture gateway license\n",
            "LICENSE-CLOUDFLARED.txt": b"fixture cloudflared license\n",
            "THIRD-PARTY-LICENSES.txt": b"Fixture dependency license texts and notices.\n",
        }
        with tarfile.open(bundle, "w:gz") as archive:
            for name, source in files.items():
                if name == "cloudflared" and version == "1.0.3":
                    info = tarfile.TarInfo(name)
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../../outside"
                    archive.addfile(info)
                else:
                    data = source.read_bytes() if source else payloads[name]
                    info = tarfile.TarInfo(name)
                    info.mode = 0o755 if name in ("gateway", "cloudflared", "proprium") else 0o644
                    info.size = len(data)
                    import io
                    archive.addfile(info, io.BytesIO(data))
            if version == "1.0.6":
                info = tarfile.TarInfo("../../proprium-lifecycle-outside")
                data = b"must never be extracted\n"
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        filename = f"proprium-gateway_{version}_linux_amd64.tar.gz"
        shutil.copy2(bundle, directory / filename)
        (directory / "SHA256SUMS").write_text(f"{sha(directory / filename)}  {filename}\n")
        assets = []
        for name in ("SHA256SUMS", filename):
            path = directory / name
            digest = sha(path)
            if version == "1.0.2" and name == filename:
                digest = "0" * 64
            assets.append({"name": name, "digest": "sha256:" + digest,
                           "browser_download_url": f"https://github.com/yohn-jp/proprium/releases/download/proprium-gateway-v{version}/{name}"})
        (directory / "release.json").write_text(json.dumps({"tag_name": f"proprium-gateway-v{version}", "draft": False, "prerelease": False, "assets": assets}))


def start_test():
    if sys.platform != "linux":
        print("SKIP: lifecycle integration requires Linux user systemd")
        return 0
    cache = pathlib.Path.home() / ".cache"
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix="proprium-lifecycle-", dir=cache))
    unit = f"proprium-test-{uuid.uuid4().hex[:12]}.service"
    unit_path = None
    extra_units = []
    env = os.environ.copy()
    try:
        if not env.get("XDG_RUNTIME_DIR") or not pathlib.Path(env["XDG_RUNTIME_DIR"], "bus").exists():
            raise RuntimeError("systemd --user D-Bus is unavailable; run under a real user manager")
        run(["systemctl", "--user", "show-environment"])
        fixtures = work / "fixtures"
        fixtures.mkdir()
        build_fixtures(fixtures, work)
        real_curl = shutil.which("curl", path=env.get("PATH"))
        shimdir = work / "shim"
        shimdir.mkdir()
        shim = shimdir / "curl"
        shim.write_text(r'''#!/usr/bin/env python3
import os, pathlib, shutil, subprocess, sys
args=sys.argv[1:]
if "--config" in args and args[args.index("--config")+1] == "-":
    cfg=sys.stdin.read()
    if "url = \"https://" in cfg and "/healthz\"" in cfg:
        if os.environ.get("LIFECYCLE_PUBLIC_FAIL") == "1": sys.exit(22)
        sys.stdout.write("ok")
        if "-w" in args: sys.stdout.write("200")
        sys.exit(0)
    sys.exit(90)
url=next((a for a in args if a.startswith("https://")), "")
if url.startswith("https://api.github.com/repos/yohn-jp/proprium/releases/latest"):
    if os.environ.get("LIFECYCLE_NETWORK_FAIL") == "1": sys.exit(22)
    src=pathlib.Path(os.environ["LIFECYCLE_FIXTURES"])/os.environ["LIFECYCLE_VERSION"] / "release.json"
elif url.startswith("https://github.com/yohn-jp/proprium/releases/download/"):
    src=pathlib.Path(os.environ["LIFECYCLE_FIXTURES"])/os.environ["LIFECYCLE_VERSION"] / url.rsplit("/",1)[1]
else:
    os.execv(os.environ["LIFECYCLE_REAL_CURL"], [os.environ["LIFECYCLE_REAL_CURL"]]+args)
out=args[args.index("-o")+1] if "-o" in args else args[args.index("--output")+1]
shutil.copyfile(src,out)
''')
        shim.chmod(0o755)
        config_home = work / "config"
        # The user's manager only watches its normal unit search path. Keep this
        # run's private application config separate while registering one unique
        # unit there; cleanup removes only that generated unit.
        unit_config_home = pathlib.Path(env.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
        data = work / "data"
        bindir = work / "bin"
        env.update({"PATH": str(shimdir) + os.pathsep + env["PATH"], "LIFECYCLE_REAL_CURL": real_curl,
                    "LIFECYCLE_FIXTURES": str(fixtures), "LIFECYCLE_VERSION": "1.0.0",
                    "XDG_CONFIG_HOME": str(unit_config_home), "PROPRIUM_CONFIG_DIR": str(config_home / "proprium"),
                    "PROPRIUM_DATA_DIR": str(data),
                    "PROPRIUM_BIN_DIR": str(bindir), "PROPRIUM_UNIT": unit,
                    "PROPRIUM_LISTEN_PORT": str(port()), "PROPRIUM_METRICS_PORT": str(port())})
        # The test values are private files and never appear in process arguments.
        secret_token = "fixture-secret-token-" + uuid.uuid4().hex
        access_id = "fixture-access-id-" + uuid.uuid4().hex
        access_secret = "fixture-access-secret-" + uuid.uuid4().hex
        token_file = work / "token"
        write(token_file, secret_token + "\n")
        access_file = work / "access.env"
        write(access_file, f"CF_ACCESS_CLIENT_ID={access_id}\nCF_ACCESS_CLIENT_SECRET={access_secret}\n")
        listen = f"127.0.0.1:{env['PROPRIUM_LISTEN_PORT']}"
        metrics = f"127.0.0.1:{env['PROPRIUM_METRICS_PORT']}"
        cli = str(DIST / "proprium")
        options = ["--non-interactive", "--public-url", "https://fixture.invalid",
                "--github-client-id", "fixture-client-id", "--listen", listen, "--metrics", metrics,
                "--tunnel-token-file", str(token_file), "--access-credentials-file", str(access_file)]

        def cli_run(command, *, check=True, timeout=60, env_extra=None):
            merged = env.copy()
            if env_extra:
                merged.update(env_extra)
            result = run([cli, command] + options, env=merged, check=check, timeout=timeout)
            combined = result.stdout + result.stderr
            assert secret_token not in combined and access_secret not in combined, "secret appeared in CLI output"
            return result

        unit_path = unit_config_home / "systemd/user" / unit
        cli_run("install", timeout=150)
        assert unit_path.is_file()
        assert secret_token not in unit_path.read_text() and access_secret not in unit_path.read_text()
        assert "EnvironmentFile" not in unit_path.read_text(), "fixture secrets must be sourced from protected config only"
        token_config = config_home / "proprium/tunnel.yml"
        assert token_config.is_file() and token_config.stat().st_mode & 0o777 == 0o600
        assert os.readlink(data / "current") == "releases/1.0.0"
        assert cli_run("status").returncode == 0
        installed_env = env.copy()
        for name in ("PROPRIUM_CONFIG_DIR", "PROPRIUM_DATA_DIR", "PROPRIUM_BIN_DIR", "PROPRIUM_UNIT"):
            installed_env.pop(name, None)
        installed = run([str(bindir / "proprium"), "status"], env=installed_env)
        assert "Gateway health: ok" in installed.stdout and "Public route: ok" in installed.stdout
        cli_run("setup")
        cli_run("install", timeout=90)
        cli_run("restart")

        # Credentials-file mode writes a private configuration independently of the running token-mode unit.
        tunnel_id = "12345678-1234-1234-1234-123456789abc"
        credentials_file = work / "credentials.json"
        write(credentials_file, json.dumps({"TunnelID": tunnel_id, "AccountTag": "fixture-account", "TunnelSecret": "fixture-tunnel-secret"}) + "\n")
        credential_config = work / "credentials-config"
        credential_listen = f"127.0.0.1:{port()}"
        credential_metrics = f"127.0.0.1:{port()}"
        cred_setup = run([cli, "setup", "--non-interactive", "--config-dir", str(credential_config),
                          "--public-url", "https://fixture-credentials.invalid", "--github-client-id", "fixture-client-id",
                          "--listen", credential_listen, "--metrics", credential_metrics,
                          "--tunnel-credentials-file", str(credentials_file), "--tunnel-id", tunnel_id,
                          "--access-credentials-file", str(access_file)], env=env)
        assert "fixture-tunnel-secret" not in cred_setup.stdout + cred_setup.stderr
        assert (credential_config / "tunnel.json").stat().st_mode & 0o777 == 0o600
        assert f"credentials-file: {json.dumps(str(credential_config / 'tunnel.json'))}" in (credential_config / "tunnel.yml").read_text()
        runtime = pathlib.Path(env["XDG_RUNTIME_DIR"]) / f"proprium-{unit.removesuffix('.service')}"
        assert_no_secret_argv(env, unit, runtime, secret_token, access_secret)
        assert_child_secret_env(runtime, secret_token, access_secret, access_id)

        # A real live MCP session blocks ordinary service shutdown; maintenance explicitly revokes it.
        gateway_url = f"http://{listen}"
        request = urllib.request.Request(gateway_url + "/live/sessions", data=json.dumps({"workspaceId": "test", "generation": "1", "capabilities": []}).encode(),
            headers={"Content-Type": "application/json", "Origin": "https://proprium.yohn.jp"})
        # Owner Key is generated during setup and held only in the private gateway config.
        owner_line = next(line for line in (config_home / "proprium/gateway.env").read_text().splitlines() if line.startswith("PROPRIUM_OWNER_KEY="))
        owner = owner_line.split("=", 1)[1]
        request.add_header("Authorization", "Bearer " + owner)
        with urllib.request.urlopen(request, timeout=5) as response:
            session = json.load(response)
        event_request = urllib.request.Request(
            f"{gateway_url}/live/sessions/{session['sessionId']}/events",
            headers={"Authorization": "Bearer " + session["ownerToken"],
                     "Origin": "https://proprium.yohn.jp", "Accept": "text/event-stream"})
        stream_ready = threading.Event()
        stream_finished = threading.Event()
        stream_errors = []

        def consume_events():
            try:
                with urllib.request.urlopen(event_request, timeout=60) as stream:
                    while line := stream.readline():
                        if line.startswith(b"event: ready"):
                            stream_ready.set()
            except BaseException as error:
                stream_errors.append(error)
            finally:
                stream_finished.set()

        stream_thread = threading.Thread(target=consume_events, daemon=True)
        stream_thread.start()
        assert stream_ready.wait(5), f"Live MCP event stream did not become active: {stream_errors}"
        env["LIFECYCLE_VERSION"] = "1.0.1"
        blocked_update = cli_run("update", check=False, timeout=30)
        assert blocked_update.returncode != 0 and "Active MCP" in blocked_update.stderr, "active stream did not protect update"
        assert os.readlink(data / "current") == "releases/1.0.0"
        assert not stream_finished.is_set(), "blocked update closed the active MCP stream"
        assert_no_secret_argv(env, unit, runtime, secret_token, access_secret, owner, session["ownerToken"])
        stop = cli_run("stop", check=False)
        assert stop.returncode != 0 and "Active MCP" in stop.stderr, "active MCP session did not protect stop"
        run([cli, "stop", "--non-interactive", "--maintenance"] + options[1:], env=env, check=True, timeout=30)
        assert not runtime.exists(), "systemd did not remove its private runtime directory on stop"
        assert stream_finished.wait(5), f"maintenance stop did not close active stream: {stream_errors}"
        gateway_config = config_home / "proprium/gateway.env"
        original_config = gateway_config.read_text()
        marker = work / "shell-executed"
        injection = f"$(touch${{IFS}}{marker})" + "x" * 40
        gateway_config.write_text("\n".join(
            f"PROPRIUM_OWNER_KEY={injection}" if line.startswith("PROPRIUM_OWNER_KEY=") else line
            for line in original_config.splitlines()) + "\n")
        gateway_config.chmod(0o600)
        cli_run("status", check=False)
        assert not marker.exists(), "configuration value was interpreted as shell code"
        gateway_config.write_text(original_config)
        gateway_config.chmod(0o600)
        cli_run("start", timeout=45)
        assert runtime.is_dir(), "systemd did not recreate its private runtime directory on start"
        assert cli_run("status").returncode == 0

        # Stopping either child must make the supervisor stop its peer and systemd restart both.
        first_gateway = int((runtime / "gateway.pid").read_text())
        first_tunnel = int((runtime / "cloudflared.pid").read_text())
        run(["systemctl", "--user", "reset-failed", unit], env=env)
        os.kill(first_gateway, signal.SIGKILL)
        wait_recovered(cli_run, unit, runtime, "gateway", first_gateway, "cloudflared", first_tunnel, timeout=45)
        assert cli_run("status").returncode == 0
        first_tunnel = int((runtime / "cloudflared.pid").read_text())
        first_gateway = int((runtime / "gateway.pid").read_text())
        run(["systemctl", "--user", "reset-failed", unit], env=env)
        os.kill(first_tunnel, signal.SIGKILL)
        wait_recovered(cli_run, unit, runtime, "cloudflared", first_tunnel, "gateway", first_gateway, timeout=45)
        assert cli_run("status").returncode == 0

        # Cross-process operation lock is honored while a second lifecycle command runs.
        with open(data / ".lock", "a") as lockfile:
            fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
            busy = cli_run("update", check=False)
            assert busy.returncode != 0 and "Another lifecycle operation" in busy.stderr
        cli_run("restart")

        # A running update commits atomically and the verified prior release can be restored.
        env["LIFECYCLE_VERSION"] = "1.0.1"
        cli_run("update", timeout=90)
        assert os.readlink(data / "current") == "releases/1.0.1"
        cli_run("rollback", timeout=90)
        assert os.readlink(data / "current") == "releases/1.0.0"

        for version, label in (("1.0.2", "GitHub API digest"),
                               ("1.0.3", "Archive links/special files are forbidden"),
                               ("1.0.6", "Unsafe or unexpected archive member")):
            env["LIFECYCLE_VERSION"] = version
            failed = cli_run("update", check=False, timeout=45)
            assert failed.returncode != 0 and label in failed.stderr, (version, failed.stderr)
            assert os.readlink(data / "current") == "releases/1.0.0"
            assert cli_run("status").returncode == 0
        env["LIFECYCLE_NETWORK_FAIL"] = "1"
        failed = cli_run("update", check=False, timeout=30)
        assert failed.returncode != 0 and os.readlink(data / "current") == "releases/1.0.0"
        env.pop("LIFECYCLE_NETWORK_FAIL")

        env["LIFECYCLE_VERSION"] = "1.0.5"
        mv_shim_dir = work / "mv-shim"
        mv_shim_dir.mkdir()
        real_mv = shutil.which("mv", path=env["PATH"])
        mv_shim = mv_shim_dir / "mv"
        mv_shim.write_text("""#!/usr/bin/env python3
import os, pathlib, sys
args=sys.argv[1:]
if (os.environ.get('LIFECYCLE_FAIL_CURRENT_MV') == '1' and args and
    args[-1] == os.environ.get('LIFECYCLE_CURRENT_LINK') and
    not pathlib.Path(os.environ['LIFECYCLE_FAIL_MARKER']).exists()):
    pathlib.Path(os.environ['LIFECYCLE_FAIL_MARKER']).touch()
    sys.exit(1)
os.execv(os.environ['LIFECYCLE_REAL_MV'], [os.environ['LIFECYCLE_REAL_MV']]+args)
""")
        mv_shim.chmod(0o755)
        switch_env = {"PATH": str(mv_shim_dir) + os.pathsep + env["PATH"],
                      "LIFECYCLE_FAIL_CURRENT_MV": "1", "LIFECYCLE_CURRENT_LINK": str(data / "current"),
                      "LIFECYCLE_FAIL_MARKER": str(work / "mv-failed-once"), "LIFECYCLE_REAL_MV": real_mv}
        failed = cli_run("update", check=False, timeout=60, env_extra=switch_env)
        assert failed.returncode != 0 and (work / "mv-failed-once").exists(), "current symlink switch fault was not injected"
        assert os.readlink(data / "current") == "releases/1.0.0"
        wait_cli_healthy(cli_run, timeout=20)

        env["LIFECYCLE_VERSION"] = "1.0.4"
        failed = cli_run("update", check=False, timeout=75)
        assert failed.returncode != 0 and "restored healthy release 1.0.0" in failed.stderr, failed.stderr
        assert os.readlink(data / "current") == "releases/1.0.0"
        assert cli_run("status").returncode == 0
        journal = run(["journalctl", "--user", "-u", unit, "--no-pager"], env=env).stdout
        assert secret_token not in journal and access_secret not in journal and owner not in journal and session["ownerToken"] not in journal, "service journal leaked a secret"

        # A second real unit exercises credentials-file cloudflared argv/config and environment isolation.
        credential_unit = unit.removesuffix(".service") + "-credentials.service"
        credential_unit_path = unit_config_home / "systemd/user" / credential_unit
        credential_data = work / "credentials-data"
        credential_bin = work / "credentials-bin"
        extra_units.append((credential_unit, credential_unit_path))
        credential_env = env.copy()
        credential_env.update({"PROPRIUM_UNIT": credential_unit, "PROPRIUM_CONFIG_DIR": str(credential_config),
                               "PROPRIUM_DATA_DIR": str(credential_data), "PROPRIUM_BIN_DIR": str(credential_bin),
                               "LIFECYCLE_VERSION": "1.0.0"})
        credential_install = run([cli, "install", "--non-interactive", "--public-url", "https://fixture-credentials.invalid",
                                  "--github-client-id", "fixture-client-id", "--listen", credential_listen,
                                  "--metrics", credential_metrics, "--tunnel-credentials-file", str(credentials_file),
                                  "--tunnel-id", tunnel_id], env=credential_env, timeout=150)
        assert "fixture-tunnel-secret" not in credential_install.stdout + credential_install.stderr
        assert credential_unit_path.is_file()
        assert "Gateway health: ok" in credential_install.stdout and "Tunnel readiness: connected" in credential_install.stdout
        assert_no_secret_argv(credential_env, credential_unit,
                              pathlib.Path(env["XDG_RUNTIME_DIR"]) / f"proprium-{credential_unit.removesuffix('.service')}",
                              "fixture-tunnel-secret", "fixture-tunnel-secret")
        assert_child_secret_env(pathlib.Path(env["XDG_RUNTIME_DIR"]) / f"proprium-{credential_unit.removesuffix('.service')}",
                                "fixture-tunnel-secret", "fixture-tunnel-secret", access_id)
        credential_journal = run(["journalctl", "--user", "-u", credential_unit, "--no-pager"], env=credential_env).stdout
        assert "fixture-tunnel-secret" not in credential_journal, "Tunnel credential leaked to credentials-mode service journal"
        assert session["sessionId"]
        print("real user-systemd lifecycle integration passed (GitHub release and public health HTTPS fixture-backed)")
        return 0
    finally:
        # The service name is unique and belongs only to this invocation.
        for managed_unit in [unit, *(name for name, _ in extra_units)]:
            subprocess.run(["systemctl", "--user", "stop", managed_unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["systemctl", "--user", "disable", managed_unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        generated_units = ([unit_path] if unit_path else []) + [path for _, path in extra_units]
        for path in generated_units:
            path.unlink(missing_ok=True)
        subprocess.run(["systemctl", "--user", "daemon-reload"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(work, ignore_errors=True)


def wait_recovered(cli_run, unit, runtime, process, old_pid, peer, peer_pid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            current = int((runtime / f"{process}.pid").read_text())
        except (FileNotFoundError, ValueError):
            current = old_pid
        if current != old_pid:
            result = cli_run("status", check=False, timeout=15)
            if result.returncode == 0:
                assert not pathlib.Path(f"/proc/{peer_pid}").exists(), f"supervisor left the crashed {peer} peer running"
                return
        time.sleep(0.5)
    raise AssertionError(f"systemd did not restart Gateway/Tunnel peer after {process} crash ({unit})")


def wait_cli_healthy(cli_run, timeout):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = cli_run("status", check=False, timeout=15)
        if last.returncode == 0:
            return
        time.sleep(0.5)
    raise AssertionError(f"managed service did not recover after switch failure: {last.stdout if last else ''}\n{last.stderr if last else ''}")


def assert_no_secret_argv(env, unit, runtime, token, access_secret, *other_secrets):
    supervisor = run(["systemctl", "--user", "show", "--property=MainPID", "--value", unit], env=env).stdout.strip()
    pids = [int(supervisor), int((runtime / "gateway.pid").read_text()), int((runtime / "cloudflared.pid").read_text())]
    for pid in pids:
        arguments = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes()
        secrets = (token, access_secret) + other_secrets
        assert all(secret.encode() not in arguments for secret in secrets), f"secret leaked in argv for pid {pid}"


def assert_child_secret_env(runtime, token, access_secret, access_id):
    gateway_env = pathlib.Path("/proc") / (runtime / "gateway.pid").read_text().strip() / "environ"
    tunnel_env = pathlib.Path("/proc") / (runtime / "cloudflared.pid").read_text().strip() / "environ"
    gateway_data = gateway_env.read_bytes()
    tunnel_data = tunnel_env.read_bytes()
    assert token.encode() not in gateway_data and access_secret.encode() not in gateway_data and access_id.encode() not in gateway_data, "Tunnel/Access credential leaked into Gateway environment"
    assert access_secret.encode() not in tunnel_data and access_id.encode() not in tunnel_data, "Access credential leaked into Tunnel environment"
    assert b"PROPRIUM_OWNER_KEY=" not in tunnel_data, "Gateway Owner Key leaked into Tunnel environment"


if __name__ == "__main__":
    try:
        raise SystemExit(start_test())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise
