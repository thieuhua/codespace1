import json
from pathlib import Path
import subprocess
import sys
import unittest


class StressTests(unittest.TestCase):
    def test_under_one_gib_process_limit(self):
        proc = subprocess.run([sys.executable, str(Path(__file__).with_name("stress_worker.py"))],
                              capture_output=True, text=True, timeout=90)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["messages"], 2000)
        self.assertLess(result["peak_rss_bytes"], 1024 ** 3)
        print("STRESS " + json.dumps(result))
