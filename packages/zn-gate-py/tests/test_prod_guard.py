"""The production data guard, Python side: the corpus shared with the Node.js package (every risky command found under the
same rule, every benign look-alike allowed), the repository reading for a push that names no branch, and linear time."""

import json
import re
import tempfile
import time
import unittest
from pathlib import Path

from zn_gate.prod_guard import PROD_GUARD_RULES_VERSION, RULES, ProdGuardHit, check_production_data

CORPUS_FILE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "destructive_commands.json"
CORPUS = json.loads(CORPUS_FILE.read_text(encoding="utf-8"))


def rule(command, cwd=None):
    hit = check_production_data(command, cwd)
    return hit.rule if hit else None


def make_repo(head, origin_head=None):
    root = Path(tempfile.mkdtemp(prefix="zn-prodguard-"))
    git = root / ".git"
    (git / "refs" / "remotes" / "origin").mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/" + head + "\n")
    if origin_head:
        (git / "refs" / "remotes" / "origin" / "HEAD").write_text("ref: refs/remotes/origin/" + origin_head + "\n")
    sub = root / "src"
    sub.mkdir()
    return root, sub


class ProductionGuardCorpus(unittest.TestCase):
    def test_git_push_mirror_is_asked_without_force(self):
        for c in ["git push --mirror origin", "git push origin --mirror", "git push --mirror", "git push --mirror=origin", "git push -v --mirror origin",
                  "git push --no-verify --mirror origin", "git push --mirror --force origin", "git -C /srv/app push --mirror origin",
                  "cd /srv/app && git push origin --mirror"]:
            self.assertEqual(rule(c), "git_force_push_protected", c)
        self.assertIn("all branches, protected ones included", check_production_data("git push --mirror origin").message)
        self.assertIsNone(rule("git push origin mirror"))
        self.assertIsNone(rule("git push --all origin"))
        self.assertIsNone(rule("git push --dry-run origin main"))

    def test_deleting_a_protected_branch_is_asked(self):
        for c in ["git push origin --delete main", "git push --delete origin master", "git push origin -d main", "git push -d origin release/1.2", "git push origin :main",
                  "git push origin :refs/heads/main", "git push origin --delete feature-x main", "git push origin :feature-x :master", "git push origin --delete refs/heads/main",
                  "git -C /srv/app push origin --delete main", "cd /srv/app && git push origin :release/2.0", "sudo git push origin -d main"]:
            self.assertEqual(rule(c), "git_delete_protected_branch", c)
        self.assertIn("deleting the protected branch main", check_production_data("git push origin --delete main").message)
        for c in ["git push origin --delete feature-x", "git push origin -d feature-x", "git push origin :feature-x", "git push origin --delete feature-x fix/typo", "git push origin main",
                  "git push origin HEAD:main", "git push origin --delete refs/tags/main", "git push origin :release"]:
            self.assertIsNone(rule(c), c)
        self.assertEqual(rule("git push origin +:main"), "git_force_push_protected")
        self.assertEqual(rule("git push --force origin HEAD:main"), "git_force_push_protected")

    def test_new_forms_are_asked_about(self):
        asks = {
            "{ terraform destroy; }": "terraform_destroy",
            "( kubectl delete ns example-prod )": "kubectl_delete_namespace",
            "{ { terraform destroy; }; }": "terraform_destroy",
            "echo hi && { kubectl delete ns example-prod; } 2>&1": "kubectl_delete_namespace",
            "{ git push --force origin main; }": "git_force_push_protected",
            "oc delete project example-prod": "kubectl_delete_namespace",
            "gcloud storage rm -r gs://example-prod-bucket": "gcloud_delete",
            "gcloud storage rm --recursive gs://example-prod-bucket": "gcloud_delete",
            "{ gcloud storage rm -r gs://example-prod-bucket; }": "gcloud_delete",
            "aws s3 sync ./empty s3://example-prod --delete": "aws_s3_delete",
            "xargs terraform destroy": "terraform_destroy",
            "echo example-prod | xargs -I{} kubectl delete ns {}": "kubectl_delete_namespace",
            "watch -n 5 terraform destroy": "terraform_destroy",
            "watch 'terraform destroy'": "terraform_destroy",
            "watch -n 5 'kubectl delete ns prod-example'": "kubectl_delete_namespace",
            "watch -x terraform destroy": "terraform_destroy",
            "watch --exec kubectl delete ns prod-example": "kubectl_delete_namespace",
        }
        for c, r in asks.items():
            self.assertEqual(rule(c), r, c)

    def test_new_forms_non_production_twins_stay_allowed(self):
        for c in [
            "{ terraform plan; }", "{ kubectl delete pod web-1 -n example-prod; }", "( kubectl get ns )", "{ echo terraform destroy; }", "oc delete pod web-1", "oc get projects",
            "gcloud storage rm gs://example-prod-bucket/file.txt", "gcloud storage ls -r gs://example-prod-bucket", "aws s3 sync ./dist s3://example-prod-bucket",
            "aws s3 sync ./dist s3://example-prod-bucket --delete --dryrun", "xargs echo terraform destroy", "watch -n 5 df -h",
            "watch 'kubectl get pods'", "watch -n 2 'ls -la'", "watch -x echo terraform destroy", "watch 'echo terraform destroy'",
        ]:
            self.assertIsNone(rule(c), c)

    def test_corpus_size_and_rules(self):
        self.assertGreaterEqual(len(CORPUS["prod_benign"]), 100)
        self.assertGreaterEqual(len(CORPUS["prod_risky"]), 300)
        self.assertEqual(sorted({"prod:" + r["rule"] for r in CORPUS["prod_risky"]}), sorted(RULES))
        self.assertRegex(PROD_GUARD_RULES_VERSION, r"^\d{4}-\d{2}-\d{2}\.\d+\Z")

    def test_every_risky_command_is_found_under_its_rule(self):
        wrong = [(r["rule"], r["cmd"], rule(r["cmd"])) for r in CORPUS["prod_risky"] if rule(r["cmd"]) != r["rule"]]
        self.assertEqual(wrong, [])

    def test_no_benign_look_alike_is_found(self):
        self.assertEqual([c for c in CORPUS["prod_benign"] if rule(c) is not None], [])

    def test_shapes_the_guard_does_not_read_are_allowed(self):
        self.assertEqual([x["cmd"] for x in CORPUS["prod_not_covered"] if rule(x["cmd"]) is not None], [])

    def test_the_look_alikes_named_in_the_spec(self):
        for c in [
            "psql -c \"SELECT * FROM users WHERE name = 'DROP TABLE'\"",
            "terraform plan -destroy",
            "kubectl delete pod web-1",
            "aws s3 rm s3://example-bucket/file.txt",
            "gcloud sql instances describe prod-db-example",
            "git push --force origin feature/login",
            "psql prod-db-example <<EOF\nSELECT * FROM users;\nEOF",
        ]:
            self.assertIsNone(rule(c), c)


class ProductionGuardShape(unittest.TestCase):
    def test_answer(self):
        r = check_production_data("terraform destroy -auto-approve")
        self.assertIsInstance(r, ProdGuardHit)
        self.assertEqual(r.id, "prod:terraform_destroy")
        self.assertTrue(r.message.startswith("zn: this command is terraform destroy"))
        self.assertIn("Approve only if the user asked for exactly this", r.message)
        self.assertTrue(r.deny.startswith("zn blocked this: it is terraform destroy"))
        self.assertIn("Next step: ask the user to confirm", r.deny)
        self.assertIsNone(check_production_data(None))
        self.assertIsNone(check_production_data(""))
        self.assertIsNone(check_production_data(42))

    def test_sql_reading(self):
        self.assertEqual(rule('psql -c "SELECT 1; DROP TABLE users"'), "sql_drop")
        self.assertEqual(rule("psql -c \"SELECT 'it''s'; DROP TABLE users\""), "sql_drop")
        self.assertIsNone(rule("psql -c \"SELECT 'a;DROP TABLE users'\""))
        self.assertIsNone(rule('psql -c "SELECT 1 /* ; DROP TABLE users */"'))
        self.assertEqual(rule("psql -c \"SELECT 'oops; DROP TABLE users\""), "sql_drop")
        self.assertIsNone(rule('mysql -e "SELECT TRUNCATE (3.14159, 2)"'))
        self.assertEqual(rule("psql db <<EOF\nDROP TABLE users;\nEOF"), "sql_drop")
        self.assertIsNone(rule("cat <<EOF > notes.txt\nDROP TABLE users;\nEOF"))
        self.assertIsNone(rule("psql db <<EOF\nDROP TABLE users;"))
        self.assertEqual(rule("bash <<EOF\nterraform destroy\nEOF"), "terraform_destroy")

    def test_git_branches_from_the_repository_files(self):
        on_main, _ = make_repo("main")
        on_feature, feature_sub = make_repo("feature/login", "main")
        on_trunk, _ = make_repo("trunk", "trunk")
        other, _ = make_repo("feature/x", "trunk")
        self.assertEqual(rule("git push --force", str(on_main)), "git_force_push_protected")
        self.assertEqual(rule("git push --force origin HEAD", str(on_main)), "git_force_push_protected")
        self.assertIsNone(rule("git push --force", str(feature_sub)))
        self.assertEqual(rule("git push --force", str(on_trunk)), "git_force_push_protected")
        self.assertEqual(rule("git push --force origin trunk", str(other)), "git_force_push_protected")
        self.assertEqual(rule("git -C " + str(on_main) + " push --force", str(on_feature)), "git_force_push_protected")
        self.assertIsNone(rule("git push --force", tempfile.mkdtemp(prefix="zn-norepo-")))
        self.assertIsNone(rule("git push --force"))
        self.assertIsNone(rule("git push", str(on_main)))
        self.assertIn("the protected branch main", check_production_data("git push --force origin main").message)
        self.assertIn("all branches, protected ones included", check_production_data("git push --force --all").message)

    def test_hostile_input_stays_fast(self):
        inputs = [
            "a" * 100000, "'" * 100001, '"' * 100001, 'psql -c "' + "'a" * 40000, 'psql -c "' + " " * 100000 + 'DROP TABLE x"',
            "psql <<EOF\n" + "a\n" * 50000, "psql <<EOF\n" * 20000, "<<EOF " * 20000, 'psql -c "' + ";" * 100000 + '"', 'psql -c "' + "\n" * 100000 + '"',
            "git push " + "--force " * 20000, "aws " + "--profile x " * 10000 + "s3 rm", "kubectl " + "-n x " * 20000 + "delete",
            "gcloud " + "sql instances " * 20000, "/*" * 50000, "--" * 50000, "sh -c " * 15000, "; " * 40000,
        ]
        for s in inputs:
            t0 = time.time()
            check_production_data(s)
            self.assertLess(time.time() - t0, 5, "slow input: %r (%d chars)" % (s[:20], len(s)))


if __name__ == "__main__":
    unittest.main()
