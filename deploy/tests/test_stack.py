"""Static deployment invariant tests. Requires PyYAML, no Docker daemon."""
from pathlib import Path
import unittest
import shutil
import subprocess
import yaml

DEPLOY = Path(__file__).resolve().parents[1]

def parse(name):
    return yaml.safe_load((DEPLOY / name).read_text(encoding="utf-8"))

class DeploymentContract(unittest.TestCase):
    def setUp(self):
        self.base = parse("compose.yaml")
        self.prod = parse("compose.prod.yaml")
        self.dev = parse("compose.dev.yaml")
        self.external = parse("compose.external-model.yaml")

    def test_all_profiles_parse_and_have_expected_services(self):
        self.assertEqual(set(self.base["services"]), {"postgres", "redis", "ollama"})
        for mode in [self.prod, self.dev]:
            self.assertEqual(set(mode["services"]), {"api", "worker", "migrate", "web"})
        self.assertEqual(self.base["services"]["redis"]["profiles"], ["cache"])
        self.assertEqual(self.base["services"]["ollama"]["profiles"], ["local-inference"])

    def test_internal_data_plane_and_no_database_ports(self):
        self.assertTrue(self.base["networks"]["backend"]["internal"])
        for name in ["postgres", "redis", "ollama"]:
            svc = self.base["services"][name]
            self.assertNotIn("ports", svc)
            self.assertEqual(svc["networks"], ["backend"])
            self.assertNotIn("privileged", svc)
        self.assertIn("postgres_data", self.base["volumes"])
        self.assertIn("ollama_models", self.base["volumes"])

    def test_secrets_never_interpolated_into_yaml(self):
        for config in [self.base, self.prod, self.dev, self.external]:
            content = str(config)
            self.assertNotIn("POSTGRES_PASSWORD:", content)
            self.assertNotIn("OPENAI_API_KEY:", content)
            self.assertNotIn("password123", content)
        self.assertEqual(self.base["services"]["postgres"]["environment"]["POSTGRES_PASSWORD_FILE"], "/run/secrets/postgres_password")
        self.assertEqual(self.external["secrets"]["provider_api_key"]["file"], "./secrets/provider_api_key")
        for mode in [self.prod, self.dev]:
            for role in ["api", "worker", "migrate"]:
                mounted = mode["services"][role]["secrets"]
                if role == "migrate":
                    self.assertIn("postgres_password", mounted)
                    self.assertIn("postgres_runtime_password", mounted)
                else:
                    self.assertIn("postgres_runtime_password", mounted)
                    self.assertNotIn("postgres_password", mounted)
            self.assertEqual(mode["services"]["api"]["environment"]["POSTGRES_USER"],
                             "${POSTGRES_RUNTIME_USER:-scopehatch_runtime}")

    def test_migrations_gated_and_processes_nonroot(self):
        for mode in [self.prod, self.dev]:
            self.assertEqual(mode["services"]["migrate"]["depends_on"]["postgres"]["condition"], "service_healthy")
            for role in ["api", "worker"]:
                svc = mode["services"][role]
                self.assertEqual(svc["depends_on"]["migrate"]["condition"], "service_completed_successfully")
                self.assertEqual(svc["user"], "1000:1000")
                self.assertEqual(svc["cap_drop"], ["ALL"])
                self.assertIn("no-new-privileges:true", svc["security_opt"])

    def test_prod_only_web_is_published_and_loopback_by_default(self):
        for role in ["api", "worker", "migrate"]:
            self.assertNotIn("ports", self.prod["services"][role])
        self.assertTrue(self.prod["services"]["web"]["ports"][0].startswith("${WEB_BIND_IP:-127.0.0.1}:"))
        self.assertTrue(self.prod["services"]["web"]["read_only"])
        self.assertIn("healthcheck", self.prod["services"]["api"])
        self.assertIn("healthcheck", self.prod["services"]["web"])
        self.assertNotIn("healthcheck", self.prod["services"]["worker"])

    def test_dockerfile_build_targets_and_secret_exclusion(self):
        for name in ["Dockerfile.api", "Dockerfile.web"]:
            content = (DEPLOY / name).read_text()
            self.assertIn("AS development", content)
            self.assertIn("AS runtime", content)
            ignored = (DEPLOY / (name + ".dockerignore")).read_text()
            self.assertIn("deploy/secrets", ignored)
            self.assertIn(".env", ignored)

    def test_provider_secret_only_in_optional_overlay(self):
        self.assertNotIn("provider_api_key", self.prod.get("secrets", {}))
        for role in ["api", "worker"]:
            self.assertIn("provider_api_key", self.external["services"][role]["secrets"])
            self.assertNotIn("postgres_password", self.external["services"][role]["secrets"])
            self.assertIn("postgres_runtime_password", self.external["services"][role]["secrets"])


    def test_recovery_scripts_are_isolated_and_wired_to_real_integrity_checks(self):
        script = (DEPLOY / "scripts/rehearse-recovery.sh").read_text()
        upgrade = (DEPLOY / "scripts/verify-upgrade.sh").read_text()
        sql = (DEPLOY / "tests/recovery-integrity.sql").read_text()
        self.assertIn("--network none", script)
        self.assertIn("--rm --network none", script)
        self.assertIn("pg_dump", script)
        self.assertIn("pg_restore --list", script)
        self.assertIn("--exit-on-error", script)
        self.assertIn("fingerprints", script)
        self.assertIn('migrate "$target_id"', script)
        self.assertIn("trap cleanup EXIT", script)
        self.assertNotIn("docker volume rm", script)
        self.assertNotIn("docker compose down", script)
        for relation in ("scope_revisions", "reviews", "inference_reservations",
                         "idempotency_records", "audit_events", "catalog_versions"):
            self.assertIn(relation, sql)
        self.assertIn("SET LOCAL ROLE scopehatch_rehearsal_runtime", sql)
        self.assertIn("preflight.sh prod", upgrade)
        self.assertIn("exited:0", upgrade)
        self.assertNotIn("docker compose down", upgrade)

    def test_backup_runbook_preserves_acl_grants(self):
        runbook = (DEPLOY.parent / "docs/operations/backup-and-restore.md").read_text()
        self.assertIn("--no-owner", runbook)
        self.assertNotIn("--no-owner --no-acl", runbook)
        self.assertIn("recovery-rehearsal.md", runbook)


    def test_node_recovery_contracts_when_node_is_installed(self):
        if not shutil.which("node"):
            self.skipTest("Node not available; run node --test deploy/tests/recovery.test.mjs separately")
        result = subprocess.run(
            ["node", "--test", "deploy/tests/recovery.test.mjs"],
            cwd=DEPLOY.parent, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
