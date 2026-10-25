#!/usr/bin/env python3
"""Exercise real CLI secret validation under a bounded address space."""
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import unittest


CLI = Path(__file__).with_name("proprium").resolve()


def limit_memory():
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024,) * 2)


class ConfigValidation(unittest.TestCase):
    def setup_config(self, *, owner="o" * 32, token="t" * 20,
                     access_id="i", access_secret="s", valid=True):
        with tempfile.TemporaryDirectory(prefix="proprium-config-") as directory:
            root = Path(directory)
            config = root / "config"
            config.mkdir(mode=0o700)
            files = {
                "gateway.env": (
                    "PROPRIUM_LISTEN_ADDR=127.0.0.1:8080\n"
                    "PROPRIUM_HOST_ORIGIN=https://host.invalid\n"
                    "PROPRIUM_PUBLIC_URL=https://gateway.invalid\n"
                    "GITHUB_CLIENT_ID=fixture-client-id\n"
                    f"PROPRIUM_OWNER_KEY={owner}\n"
                ),
                "tunnel.env": f"TUNNEL_TOKEN={token}\n",
                "settings": "TUNNEL_MODE=token\nMETRICS=127.0.0.1:20000\n",
                "access.env": (f"CF_ACCESS_CLIENT_ID={access_id}\n"
                               f"CF_ACCESS_CLIENT_SECRET={access_secret}\n"),
            }
            for name, contents in files.items():
                path = config / name
                path.write_text(contents)
                path.chmod(0o600)
            result = subprocess.run(
                ["bash", str(CLI), "setup", "--non-interactive",
                 "--config-dir", str(config), "--data-dir", str(root / "data"),
                 "--bin-dir", str(root / "bin")],
                env={**os.environ, "LC_ALL": "C"}, text=True,
                capture_output=True, timeout=10, preexec_fn=limit_memory,
            )
            if valid:
                self.assertEqual(result.returncode, 0, result.stderr)
                for name, contents in files.items():
                    self.assertEqual(sorted((config / name).read_text().splitlines()),
                                     sorted(contents.splitlines()))
            else:
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("proprium: Invalid", result.stderr)
            self.assertNotIn("Memory exhausted", result.stderr)

    def test_valid_bounds(self):
        self.setup_config()
        self.setup_config(owner="!~:@" * 8, token="aA0_+/=-" * 3,
                          access_id="aA0._=-", access_secret="aA0._=-")
        self.setup_config(owner="o" * 4096, token="t" * 16384,
                          access_id="i" * 4096, access_secret="s" * 4096)

    def test_invalid_lengths_and_characters(self):
        for field, values in {
            "owner": ["o" * 31, "o" * 4097, "o" * 32 + " "],
            "token": ["", "t" * 19, "t" * 16385, "t" * 20 + "!"],
            "access_id": ["", "i" * 4097, "i!"],
            "access_secret": ["", "s" * 4097, "s "],
        }.items():
            for value in values:
                with self.subTest(field=field, length=len(value)):
                    self.setup_config(**{field: value}, valid=False)


if __name__ == "__main__":
    unittest.main()
